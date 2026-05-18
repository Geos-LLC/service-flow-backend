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

## Issue #2 — Territory resolution should be at customer-create time, not job-create time

**Discovered:** 2026-05-18 (during Phase B dry-run smoke + operator clarification of intended UX)
**Severity:** Low (current job-side resolver is functional but wrong-layered)
**Scope:** Customer creation flow + customers schema + job-create endpoint + SF frontend.
**Status:** Open. Tracked as the proper successor to commit `84456ff` (job-side resolver, treated as a band-aid until this lands).

### Summary

> Territory should be assigned to the customer at the moment of customer creation (when the operator provides the address). The automation rule checks city + zip against existing territories. On a clean match, territory is assigned to the customer. On no/ambiguous match, an operator-facing dialog asks "Is this location correct, or is it another one?" — the operator picks from a list.

### Why customer-side beats job-side

| Concern | Job-side (current, commit `84456ff`) | Customer-side (correct) |
|---|---|---|
| Frequency of resolution | Every job-create (N times per customer) | Once at customer-create + on address edits |
| DB queries per job | 1-2 (prior-job inheritance + territory lookup) | 0 (read `customer.territory` directly) |
| Warning surface | Hidden in API response (UI may not display) | Interactive dialog at the right moment (customer interaction) |
| Territory as data model | Per-job attribute computed late | Stable customer attribute |
| Multi-property customers | Awkward (which prior job?) | Per-property territory possible |
| Operator confusion | High ("UI shows Unassigned but DB has Tampa") | Low (operator answered the dialog at customer creation) |

### Schema gap

Neither `customers` nor `customer_properties` has a `territory` column. Two design options:

**Option 1 — per-customer territory (simpler):**
```sql
ALTER TABLE customers ADD COLUMN territory varchar;
CREATE INDEX customers_territory_idx ON customers(user_id, territory) WHERE territory IS NOT NULL;
```

**Option 2 — per-property territory (more accurate for multi-property customers):**
```sql
ALTER TABLE customer_properties ADD COLUMN territory varchar;
CREATE INDEX customer_properties_territory_idx ON customer_properties(user_id, territory) WHERE territory IS NOT NULL;
```

Option 1 is what the operator's wording implies and is the simpler MVP. Option 2 is a Phase E+ refinement if the SaaS needs to handle multi-property customers in different territories.

### Implementation surfaces required

1. **Migration** — new column + index (per Option 1 above).
2. **Customer-create endpoint** (`POST /api/customers`) — call resolver after the customer row is inserted; if territory resolved, UPDATE the row.
3. **Customer-edit endpoint** (`PATCH /api/customers/:id`) — re-resolve if address fields changed.
4. **Territory preview endpoint** (`POST /api/customers/preview-territory`) — frontend calls this when address is typed/changed in the customer form, BEFORE submission. Returns `{territory, confidence, warning, alternatives}` so the UI can populate the territory field or open the disambiguation dialog.
5. **Disambiguation dialog** (frontend repo `service-flow-frontend`) — modal triggered by the preview endpoint's "ambiguous" or "no_match" response. Shows: "We couldn't match {city, zip} to a territory. Is this location correct? Pick from: [Tampa, Miami, ..., None of these]."
6. **Job-create endpoint** (`POST /api/jobs`) — when territory not explicitly provided, read from `customer.territory`. The current `84456ff` job-side resolver becomes a fallback (or is removed once customer.territory backfill is complete).
7. **Backfill migration** — for existing customers with NULL territory, run the resolver against their current address city+zip+state and populate. For customers whose last N jobs have a consistent territory, use that as a hint (with a "verify" flag).
8. **Audit log** — every territory assignment (auto, manual, edited) emits a delivery_log row or similar for traceability.

### Resolution algorithm (customer-side)

```
Given customer's service address (city, zip, state):

Tier 1 — zip code exact match
  IF any active territory has zip in territories.zip_codes (jsonb) → use it
  (Note: currently zip_codes is empty/null across all territories — needs operator
   data entry. F4 below addresses this.)

Tier 2 — exact city → territory.name match (case-insensitive)
  Single match → assign automatically (no operator interaction)
  Multiple matches → ambiguous, prompt operator

Tier 3 — city → territory.location prefix match
  Single match → auto-assign with "verify" warning
  Multiple matches → ambiguous, prompt operator

Tier 4 — geographic radius (REQUIRES geocoding API on server-side)
  Geocode customer address → find territory whose location is within radius_miles
  Single match → auto-assign
  Multiple/no match → prompt operator

Tier 5 — fallback
  → ambiguous-no-match dialog: operator picks from list of all active territories
```

### Migration to deprecate the current job-side resolver

Once customer.territory is populated for all customers:

1. Update `POST /api/jobs` to read `customer.territory` first.
2. Remove the job-side `resolveTerritory()` call from `server.js` (the lib stays as a utility).
3. Remove the `bookingWarnings` push for territory — operator already saw the dialog at customer-create.
4. The Phase B producer continues to gate on `jobs.territory` being present; this becomes a guarantee (every customer has a territory after customer-create resolution).

### Owner / next steps

This issue is tracked as the proper successor to commit `84456ff`. It is NOT a Phase B blocker — the job-side resolver works as a band-aid. Customer-side becomes the right work item AFTER:

- Phase B dry-run gate passes (target: this week)
- Phase B live-mode soak completes (per phase-b-readiness-v2 §5.2)
- Phase B implementation greenlights for live POSTs

Estimated effort:
- Migration + resolver lib: ~2 hours
- Customer-create + customer-edit endpoints: ~3 hours
- Preview endpoint + frontend dialog: ~4 hours (in `service-flow-frontend` repo)
- Backfill script + run: ~2 hours
- Tests: ~3 hours
- **Total: ~2 days of focused work**

---

## Issue tracker conventions

Add new issues below this point as `## Issue #N — <short title>`. Keep the format consistent so the doc stays scannable. Close issues by adding a `**Closed:** YYYY-MM-DD` line at the bottom of the entry rather than removing the issue (history matters).
