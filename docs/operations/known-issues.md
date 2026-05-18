# Known Operational Issues

A running log of operational issues discovered during ZB integration work. Each issue is tracked **separately** from blocker matrices — these are not Phase B gates and should NOT be conflated with gating decisions.

Each entry includes: discovery date, scope, impact, current workaround, root cause (if known), proposed fix, owner.

---

## Issue #1 — ZB team-member sync does not auto-run for newly-created providers

**Discovered:** 2026-05-18 (during Phase B dry-run smoke #2 attempts)
**Severity:** Low (workaround exists; doesn't affect production correctness)
**Scope:** Inbound ZB → SF sync only. Not related to Phase B outbound.

### Summary

> "ZB provider/team-member sync does not auto-run for newly created providers; SF-created team members have `zenbooker_id=null` and cannot be used for ZB outbound commands."

### Observable symptom

- Operator created a new team member in ZB UI.
- The team member does NOT appear in SF's `team_members` table automatically.
- Operator (working around the gap) creates a parallel team member in SF UI.
- The SF-created team member has `zenbooker_id=null` because it has no ZB counterpart.
- Phase B producer pre-flight rejects any SF job whose `team_member_id` references an unlinked SF team_member, with `defer_reason='unmapped_team_members'`.

### Root cause

Two parts:

1. **No webhook subscription for `team_member.*` events.** The ZB→SF inbound webhook handler in [zenbooker-sync.js:1576](../../zenbooker-sync.js#L1576) subscribes to:
   ```
   job.created, job.canceled, job.rescheduled, job.en_route, job.started,
   job.completed, job.service_providers.assigned, job.service_order.edited,
   invoice.payment_succeeded, invoice.payment_recorded,
   customer.edited, customer.created
   ```
   — and intentionally NOT `team_member.*`. So ZB-side team-member changes never push to SF in real time.

2. **`/api/zenbooker/sync` is operator-triggered only.** The endpoint exists and DOES pull team members from ZB when called, but it has no automatic schedule. So SF's `team_members` table is a snapshot from the most-recent operator-triggered sync.

3. **No SF→ZB team_member.create command exists.** That's a Phase E candidate per [zb-outbound-command-confirmation.md §10](../architecture/zb-outbound-command-confirmation.md). Phase B explicitly excludes provider creation.

### Current workaround

Operator-driven, two paths:

- **Path A (pull from ZB):** trigger `POST /api/zenbooker/sync` for the affected tenant. Pulls latest team_members + customers + jobs. Cost: one operator action; runs in the background.
- **Path B (mirror in SF):** create the team member manually in SF UI. Result: SF row exists with `zenbooker_id=null` (cannot be referenced in Phase B outbound — would defer with `unmapped_team_members`).

For Phase B testing, **Path A is preferred** when the team member exists in ZB. Path B is a forced workaround that doesn't unblock outbound.

### Impact on systems

| Surface | Affected? | Notes |
|---|---|---|
| Existing ZB→SF inbound sync (jobs, customers, invoices) | No | These have their own webhook subscriptions and run normally. |
| Phase A scaffolding (queue/drainer/operator endpoints) | No | Scaffolding is data-shape-only; doesn't reference team_member.zenbooker_id directly. |
| Phase B dry-run | Partial | Producer's pre-flight rejects jobs referencing unlinked SF team_members. Acceptable behavior (loud failure). |
| Phase B live mode | Partial | Same as dry-run — producer rejects at pre-flight. Live mode would never POST a malformed payload. |
| Payroll / ledger | No | Existing payroll runs on `team_members.id` (SF id), not `zenbooker_id`. |

### Proposed fixes (none committed; tracked for future work)

| # | Fix | Effort | Phase |
|---|---|---|---|
| F1 | Subscribe SF to a `team_member.*` ZB webhook if ZB offers one | Small (one line in `webhookEvents` array + handler dispatch) | Hygiene, anytime |
| F2 | Schedule a daily cron that calls `/api/zenbooker/sync` for every connected tenant | Small (existing endpoint; add scheduler) | Hygiene, anytime |
| F3 | Auto-trigger team-member sync on producer pre-flight failure with `unmapped_team_members` | Medium (graceful self-healing; depends on F1 or F2 to actually have data) | Phase E candidate |
| F4 | Build `team_member.create` SF→ZB outbound command | Large (new command type, new payload mapping) | Phase E |

### Operator action right now

For the Phase B dry-run gate, **do not use the SF-created unlinked team member**. Pick from the 52 already-linked team members (e.g., id=2623 "Georgiy Team Member" or id=2673 "Georgiy Sayapin"). This sidesteps the issue without resolving it.

### Status

**Open.** Tracked separately from Phase B gating. Not a Phase B blocker. Re-evaluate when the operator has time to either run F1/F2 or schedule F3/F4 work.

---

## Issue tracker conventions

Add new issues below this point as `## Issue #N — <short title>`. Keep the format consistent so the doc stays scannable. Close issues by adding a `**Closed:** YYYY-MM-DD` line at the bottom of the entry rather than removing the issue (history matters).
