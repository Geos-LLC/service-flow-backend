# Runtime Allow-List Design (Stage 3 Foundations)

**Status:** Design only. No code activation. No flag flips.
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-governance-principles.md](identity-governance-principles.md) — top-level governance
- [runtime-violation-taxonomy.md](runtime-violation-taxonomy.md) — RV-1 … RV-7 vocabulary
- [retirement-stage-registry.md](retirement-stage-registry.md) — stage progression
- [../operations/identity-replay-recovery-framework.md](../operations/identity-replay-recovery-framework.md) — replay interactions
- [../operations/identity-rollout-governance.md](../operations/identity-rollout-governance.md) — tenant tier interactions

---

## 1. Why this document exists

The Stage 3 transition in the enforcement roadmap moves identity write
gating from "warn-only at scanner-time" to "refuse at runtime if not on
the allow-list." This document describes the design of that allow-list
system — what it looks like, where it lives, how it interacts with
existing operational levers (freeze, replay, rollout, ownership) — so
when implementation begins, the design is not invented in the PR.

> **Scope:** Design only. The runtime gate (`lib/identity-write-gate.js`)
> exists today as a passive observer (`allowed: true` always). This doc
> describes what changes when the gate flips to enforcing.

---

## 2. Allow-list scopes (three axes)

The allow-list operates on three orthogonal axes. A write must satisfy
ALL three to proceed under Stage 3 enforcement:

### 2.1 Per-tenant scope

Each tenant has an enforcement posture:

- `unrestricted`     — Stage 3 not active. Gate passes through (today's behavior).
- `monitored`         — Gate logs but does not block.
- `enforced_strict`   — Gate refuses any write not in the per-bypass allow-list.
- `enforced_emergency`— Operator-set; permits writes from a small list of "emergency overrides" (see §5).

Storage: `users.identity_write_gate_posture` (new column, default `unrestricted`).

Transitions through these postures follow the Bronze→Silver→Gold tier
progression in `identity-rollout-governance.md`:

| Posture | Eligible tenant tier |
|---------|---------------------|
| `unrestricted` | All (default) |
| `monitored` | Bronze, Silver, Gold (opt-in) |
| `enforced_strict` | Silver, Gold (post-30d monitored soak) |
| `enforced_emergency` | Any (incident-only) |

### 2.2 Per-bypass scope

Some bypass `source=` values are NEVER refused. The operator merge endpoint
(`server.js:merge_duplicate_customers`) is the canonical example: it
legitimately needs to repoint `leads.converted_customer_id`, and the
linker's "refuse to overwrite" semantics prevent that. The gate cannot
refuse this bypass without breaking the merge endpoint.

Allow-list shape (JSON in env var or DB):

```json
{
  "permanent": [
    "server.js:merge_duplicate_customers"
  ],
  "transitional": [
    "lib/identity-backfill.js:runIdentityBackfill",
    "lib/identity-backfill.js:backfillZenbookerCustomers"
  ],
  "transitional_until": {
    "server.js:maybeCreateLeadFromOpenPhone": "2026-08-01"
  }
}
```

The `permanent` list never expires. The `transitional` list expires
when the registry retires the entry (stage-5). The `transitional_until`
list carries a date — past that date the source is no longer allow-listed
and the gate refuses.

### 2.3 Per-owner scope

Some operators are authorized to bypass their own tenant's allow-list
in an emergency. Storage: `users.identity_write_gate_emergency_actors`
(JSON array of operator user IDs). Used only when posture is
`enforced_emergency`. Each emergency write writes an audit row with
`resolved_by='emergency_override'` and `actor_id`.

---

## 3. How a write gets evaluated (Stage 3)

When Stage 3 activates, `evaluateIdentityWrite()` changes from "return
allowed: true always" to this decision tree:

```
                   ┌────────────────────────────┐
                   │  evaluateIdentityWrite()   │
                   └────────────┬───────────────┘
                                │
                ┌───────────────┴────────────────┐
                │  Read tenant posture           │
                └───────────────┬────────────────┘
                                │
       ┌────────────────────────┼─────────────────────────┐
       │                        │                         │
  unrestricted              monitored               enforced_strict
       │                        │                         │
   allowed=true            allowed=true             check per-bypass
       │                        │                         │
       │                  warn=true                 ┌─────┴──────┐
       │                                            │            │
       │                                       on list?     not on list?
       │                                            │            │
       │                                      allowed=true   ┌───┴───┐
       │                                                     │       │
       │                                              posture is  refuse
       │                                              `enforced_  (allowed=
       │                                              emergency`?  false)
       │                                                     │
       │                                              ┌──────┴───┐
       │                                              │          │
       │                                          actor in   not in
       │                                         emergency  emergency
       │                                          actors?    actors?
       │                                              │          │
       │                                        allowed=    refuse
       │                                        true        + alert
```

The decision is recorded in the gate's return value. Caller decides what
to do with `allowed=false`:

- **Backfill scripts:** log and skip the row.
- **Webhook handlers:** drop the event with structured log; downstream replay can pick it up.
- **Operator endpoints:** return `409 Conflict` with `{ reason: 'gate_refused' }`.

Refusal is never silent — gate emits `[IdentityWriteGate] decision=refused
reason=<reason>` for every blocked write.

---

## 4. Emergency override (§5 of governance principles)

Emergency override is the safety hatch for "everything's on fire and the
gate is in the way." Design:

- Posture must be `enforced_emergency` (operator must explicitly switch).
- Actor must be in `identity_write_gate_emergency_actors`.
- Override has a TTL: posture auto-reverts to `enforced_strict` after 1h.
- Every override write writes an audit row with `actor_id`, `reason`, `expires_at`.
- A daily summary lists override volume per tenant; non-zero is reviewed.

The override is NOT a way to silently bypass enforcement. It is a way to
keep the system writable while ops investigates.

---

## 5. Freeze interaction

`IDENTITY_PROJECTION_FREEZE` is the existing kill-switch
(runbook §10). It stops CRM-side projection but lets identity graph
hydration continue.

Stage 3 gate behavior under freeze:

- Freeze active + gate enforced: gate evaluates as normal, but the
  projection writes that would be blocked by freeze return
  `allowed=false, reason='frozen'` before reaching the gate's
  allow-list logic. The gate doesn't supersede freeze; freeze runs first.
- Identity-row writes (which freeze does not block) continue to consult
  the gate.

Net effect: freeze is the bigger hammer. When freeze is on, the gate's
allow-list is largely irrelevant for projection writes. This is intentional
— freeze is an incident-response tool; allow-list is a steady-state rule.

---

## 6. Replay interaction

Replay (per `identity-replay-recovery-framework.md`) reprocesses events
via the engine. Each replay invocation goes through the gate just like
the original event would.

Important nuance:

- **Tenant posture during replay** is the CURRENT posture, not the
  posture at the time of the original event. If a tenant was `monitored`
  when the event fired but is now `enforced_strict`, the replay obeys
  the strict posture.
- **`replay` is a permanent bypass class**, distinct from RV-2. Replay
  writes always have `metadata.replay=true` and `source='replay:<original>'`.
  The gate has a built-in rule: when `source` starts with `replay:`,
  consult an additional allow-list (`replay_sources`) that defaults to
  permitting all known integration sources.

This guarantees replay doesn't surprise the operator — if the gate
refuses a replay, that's because the underlying source is itself not
allow-listed.

---

## 7. Rollout interaction

Tier promotions in `identity-rollout-governance.md` are the policy gates
for posture transitions. A tenant moves from `monitored` to
`enforced_strict` only after they're on Silver tier AND have 30d in
monitored posture AND zero P1 incidents.

The rollout doc owns the promotion ritual; this doc owns the posture
field. A tenant's posture is set via the same env-var pattern as the
rollout flags (`IDENTITY_GATE_POSTURE_<TENANT_ID>` or column on
`users`).

---

## 8. Demotion

Demotion is faster than promotion:

- Any operator can demote a tenant by setting posture to `monitored`
  via Railway env var or Admin UI.
- Demotion takes effect on next process restart (~30s).
- Demotion always announced in `#identity-ops` Slack.
- No PR required.

This mirrors the rollout governance demotion ritual — by design, posture
is a fast-reversible policy decision.

---

## 9. Where the allow-list lives

| Layer | Storage | Updated by | Read frequency |
|-------|---------|-----------|----------------|
| Tenant posture | `users.identity_write_gate_posture` | PR + Railway env var fallback | At gate evaluation (cached 60s) |
| Per-bypass allow-list | Static JSON in `lib/identity-write-gate-allowlist.json` | PR only (audit-trail required) | At process start (immutable in memory) |
| Emergency actors | `users.identity_write_gate_emergency_actors` | Admin UI | At gate evaluation (cached 60s) |
| Replay sources | Static JSON (same file) | PR only | At process start |

The static JSON is in the repo to keep the allow-list under code review.
The DB-stored fields are per-tenant operational levers.

---

## 10. Migration plan (Stage 2 → Stage 3)

This section describes the implementation steps. None of these are
active today.

1. **Schema:** add `identity_write_gate_posture` (default `unrestricted`)
   and `identity_write_gate_emergency_actors` (default empty array) to
   `users`. Migration is additive — no impact on tenants who don't opt in.
2. **Gate refactor:** add the posture-aware decision tree to
   `evaluateIdentityWrite()`. Behind a `IDENTITY_WRITE_GATE_ENFORCED`
   flag (default OFF). Today's pure-observer behavior is the "OFF"
   branch.
3. **Static allow-list file:** create `lib/identity-write-gate-allowlist.json`
   with the seven currently-instrumented sources pre-populated.
4. **Caller refactor:** at each instrumented bypass site, change from
   "call gate, then write" to "call gate, branch on `allowed`, then
   write (or skip + log)". Behavior unchanged when flag is OFF; new
   behavior gated by per-tenant posture.
5. **Soak:** one tenant in `monitored` posture for 14d. Confirm gate
   evaluates correctly (zero false negatives).
6. **First strict tenant:** one Silver+ tenant promoted to
   `enforced_strict`. 7d soak.
7. **Broaden gradually:** per `rollout-governance.md` §5 promotion
   ritual.

Each step is one PR. Reverting is one Railway env var change.

---

## 11. What this document explicitly does NOT do

- Does not implement the gate logic above. The gate today returns
  `allowed=true` unconditionally.
- Does not add the schema column.
- Does not add the allow-list JSON file.
- Does not change any caller. The 7 sites today call the gate and
  ignore the return value (because today's return is always
  `allowed=true`).
- Does not change tenant behavior.

When implementation begins, this doc becomes the spec. Until then it is
the design.

---

## 12. Open questions

Things deferred to implementation time:

- **Caching strategy** for tenant posture reads. Cache TTL is 60s in
  the table above but might be lower if we observe staleness issues.
- **Per-operation granularity** — should `delete` ops be in a separate
  allow-list from `update` ops? Today the gate categorizes by operation
  but doesn't branch on it.
- **Multi-region posture** — out of scope (we have one region).
- **Async write paths** (drainers, queues) — when a drainer is the
  caller, "tenant" comes from the job payload, not the request context.
  The gate's `tenantId` field must accept that. Already supported in
  the current API.
