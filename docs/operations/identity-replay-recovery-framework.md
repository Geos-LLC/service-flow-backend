# Identity Replay & Recovery Framework

**Status:** Design only. Replay endpoint is NOT implemented today.
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-reconciliation-runbook.md](identity-reconciliation-runbook.md) — §11 (replay policy) — operator-facing rules
- [../architecture/runtime-violation-taxonomy.md](../architecture/runtime-violation-taxonomy.md) — RV-5 (replay inconsistency)
- [../architecture/runtime-allowlist-design.md](../architecture/runtime-allowlist-design.md) — gate interaction
- [../architecture/identity-governance-principles.md](../architecture/identity-governance-principles.md) — top-level governance
- [runtime-enforcement-metrics.md](runtime-enforcement-metrics.md) — replay metric contract

---

## 1. Why this document exists

The runbook (§11) defines the operator-facing replay policy: when it
is safe, what command shape to use, what guard rails apply. This
document is the architect-facing companion — it defines the
**replay capability surface** that implementation will eventually need
to provide so the policy in §11 can be exercised.

> **Scope:** Design only. No replay code today. The `POST /api/admin/identity-replay`
> endpoint named in the runbook is a contract specification, not a
> deployed endpoint.

---

## 2. Required future capabilities

Six replay capabilities must exist to fully implement the runbook §11
policy. They are listed in order of increasing scope:

### 2.1 Replay single event

```
POST /api/admin/identity-replay/event
{ source: 'leadbridge', sourceEventId: '<external_id>', tenantId: 2, dryRun: true }
```

Re-processes one specific source event through the engine. Returns
`{ planned, executed, diff_vs_original }`. Used for surgical recovery
when one event is known broken (e.g., a webhook payload was malformed
and Sigcore re-sent it).

### 2.2 Replay tenant window

```
POST /api/admin/identity-replay/tenant
{ tenantId: 2, source: 'leadbridge', windowStart: ISO, windowEnd: ISO, dryRun: true }
```

Reprocesses every event for one tenant + source within a ≤24h window.
This is the workhorse — most replay needs are tenant-scoped after a
code fix.

### 2.3 Replay source window

```
POST /api/admin/identity-replay/source
{ source: 'zenbooker', windowStart: ISO, windowEnd: ISO, dryRun: true, tenantIds: [2, 7, 12] }
```

Cross-tenant replay for a single source. Required after a source-side
bug fix (e.g., Sigcore deployed a fix to OpenPhone phone normalization
and we need to reprocess yesterday's events for all affected tenants).
The `tenantIds` array is mandatory — there is no global-all-tenants
replay.

### 2.4 Replay ambiguity resolution

```
POST /api/admin/identity-replay/ambiguity
{ ambiguityId: 123, action: 'reattempt', dryRun: true }
```

Re-runs the resolver on an ambiguity row, applying any new information
(e.g., a new identity row was created since the original ambiguity
fired). Returns the same `{ kind, identity, plan }` the engine would
return today. Operator decides via Identity Conflicts UI whether to
apply.

### 2.5 Replay projection only

```
POST /api/admin/identity-replay/projection
{ identityId: 456, dryRun: true }
```

Bypasses the resolver and just re-runs `projectIdentityToCRM` for one
identity. Used when the identity row is correct but the CRM projection
drifted (RV-6).

### 2.6 Replay graph resolution only

```
POST /api/admin/identity-replay/graph
{ source: 'leadbridge', sourceEventId: '<external_id>', dryRun: true }
```

Bypasses projection and just re-runs `resolveIdentity`. Returns the
identity row that would result. Operator can compare to the existing
identity row for diagnosis.

---

## 3. Idempotency assumptions

Replay relies on every event having a stable external ID:

| Source | Event ID column |
|--------|-----------------|
| LeadBridge | `leadbridge_contact_id` or `lb_inbound_events.id` |
| Zenbooker | `zenbooker_customer_id` or `zb_inbound_events.id` |
| OpenPhone | `sigcore_participant_id` or `openphone_message_id` |
| Sigcore (webhook) | `event.id` |
| Manual SF | composite key (operator action ID) |

The engine writes audit rows in `identity_link_audit` keyed by
`(user_id, lead_id, customer_id)` with UNIQUE constraint (migration
048). Replaying an event whose audit row already exists with
`resolved_by='automatic'` is a no-op (idempotency check before write).

**Replays that PRODUCE a different audit row than the original** are
RV-5 inconsistencies — replay halts on first occurrence.

---

## 4. Replay ordering

Within a tenant window, events MUST be replayed in their original
chronological order. Out-of-order replay can produce wrong outcomes
(e.g., a lead row referenced by a later message hasn't been created
yet). The replay engine consumes from each source's event log
(`lb_inbound_events`, `zb_inbound_events`, `op_message_log`) in
ascending `created_at` order.

Across sources within the same tenant window: no strict ordering
required. The engine's idempotency keys handle cross-source races
correctly (the second source to see an identity finds it already
resolved and links rather than creating).

---

## 5. Replay-safe paths

These engine paths are designed for replay and are guaranteed
idempotent:

- `resolveIdentity` with `source` + `externalId` — same input → same row.
- `setIdentityLead` / `setIdentityCustomer` — idempotent on the
  identity row's existing `sf_*` fields.
- `applyLeadCustomerLink` with `mode='automatic'` — refuses to overwrite
  an already-linked lead (same outcome each replay).
- `attemptScoringFallback` — idempotent IF the underlying scoring set
  hasn't changed since the original event. (See §6 for the dangerous
  edge case.)

---

## 6. Replay-dangerous paths

These paths CAN produce different outcomes on replay:

### 6.1 `attemptScoringFallback` with new data

If between the original event and the replay, new identity rows
were created or merged, the scoring fallback can find a different
match. This is by design (the bridge improves over time) but it
means a replayed event might link to a DIFFERENT customer than
the original.

**Mitigation:** Replay with `dryRun: true` first. Compare the diff.
Only proceed if the operator confirms the new outcome is preferred.

### 6.2 `applyLeadCustomerLink` with `mode='operator_repoint'`

When (and if) this mode ships, it explicitly overwrites existing
links. Replay must NEVER use this mode — replay is only for
automatic decisions, not operator-override actions.

**Mitigation:** Replay endpoints refuse `mode='operator_repoint'`
in their input schema.

### 6.3 Manual ambiguity resolutions

If an operator resolved an ambiguity manually, that resolution is
NOT in the replay event log. Replaying the original event won't
reproduce the operator's decision — the engine will go through the
ambiguity path again and write a new `communication_identity_ambiguities`
row.

**Mitigation:** Replay engine consults `identity_link_audit` for
prior operator overrides on the same `(lead_id, customer_id)` pair
and skips with `outcome='skip_operator_override'`.

### 6.4 Source-side timestamp manipulation

If a source delivers an event with `created_at` in the past (sync
catch-up), the replay might produce a different outcome than a
real-time event would. Replay engine accepts the source-supplied
timestamp; this is a known mode of harmless drift.

---

## 7. Rollback / replay interaction

If a replay produces wrong outcomes, the rollback path is:

1. Operator pauses the replay job.
2. Operator queries `identity_link_audit` for rows with
   `resolved_by='replay'` AND `resolution_reason=<replay reason>`.
3. SQL undo per runbook §5c (sets `converted_customer_id=NULL`,
   writes compensating audit row with `resolved_by='operator_rollback'`).
4. Operator investigates root cause before resuming.

Replay never auto-rollbacks. It halts on first inconsistency (RV-5)
and waits for human review.

---

## 8. Freeze semantics during replay

`IDENTITY_PROJECTION_FREEZE` interacts with replay as follows:

- **Replay endpoint refuses to run if target tenant is frozen.**
  Returns `409 Conflict` with `{ reason: 'tenant_frozen' }`.
- **Mid-replay freeze:** if freeze flips ON mid-replay, the engine
  emits `frozen` outcomes for remaining events. Operator must
  unfreeze before continuing or accept that the freeze-window events
  are deferred.
- **Replay-and-unfreeze:** the canonical recovery for a Class C2
  incident (engine bug fix): freeze → fix → unfreeze → replay window.
  See runbook §11.

The freeze flag is checked at each event evaluation, not just at
replay start, so a mid-replay freeze stops new writes immediately.

---

## 9. Rollout interaction

Tenant tier (Bronze / Silver / Gold) gates which replay capabilities
are available:

| Tier | Allowed replays |
|------|-----------------|
| Bronze | 2.1 (single event), 2.5 (projection only) |
| Silver | + 2.2 (tenant window), 2.4 (ambiguity), 2.6 (graph only) |
| Gold | + 2.3 (source window, cross-tenant) |

This is a safety progression — broader replays carry more risk and
are only authorized for tenants we trust the data on.

---

## 10. Audit trail

Every replay invocation generates two audit artifacts:

1. **Replay job row** in `identity_replay_jobs` table (not yet
   created):
   - `id`, `tenant_id`, `source`, `window_start`, `window_end`,
     `actor_id`, `reason`, `dry_run`, `started_at`, `finished_at`,
     `events_processed`, `outcomes` (JSONB).
2. **Per-event audit rows** in `identity_link_audit` with
   `resolved_by='replay'`, `resolution_reason=<replay_job_id>:<reason>`,
   and `notes` capturing the diff if any.

The `identity_replay_jobs` table is a future-state schema. Today
neither table modification nor endpoint exists.

---

## 11. Implementation order

When implementation begins:

1. **Schema:** create `identity_replay_jobs` table + add
   `resolved_by` enum value `'replay'` to `identity_link_audit`.
2. **2.1 Single event** — smallest surface, lowest blast radius.
   First implementation.
3. **2.5 Projection only** — read-only-feeling, useful for RV-6
   diagnosis.
4. **2.4 Ambiguity** — operator-driven, low risk.
5. **2.6 Graph only** — diagnostic, no writes.
6. **2.2 Tenant window** — the workhorse. Implement only after
   2.1 has 30d of clean operation.
7. **2.3 Source window** — the highest-risk endpoint. Implement
   only after the team has 90d+ of replay operational experience.

Each capability is one PR. Reverting any of them is one Railway env
var (`REPLAY_<CAPABILITY>_ENABLED`).

---

## 12. What this document explicitly does NOT do

- Does not implement any endpoint.
- Does not create the `identity_replay_jobs` table.
- Does not add the `'replay'` enum value to `identity_link_audit`.
- Does not change runtime behavior.
- Does not authorize any operator to run any replay (no replay code
  exists).

This is the contract that future replay implementation must satisfy.

---

## 13. Open questions

- **Cross-tenant replay safety.** §2.3 requires explicit `tenantIds`,
  but should it also require approval from each tenant's owner? TBD.
- **Replay budget** (runbook §11.8 says 3/day/tenant). Enforced where?
  Probably middleware on the endpoint. TBD.
- **Async vs sync.** Single-event replay can be sync. Tenant-window
  replay must be async with progress endpoint. Threshold TBD.
- **Storage retention** for `identity_replay_jobs`. Suggested: 90 days
  rolling; archive to S3 if longer needed.
