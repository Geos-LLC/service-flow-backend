# ZB Cleanup — Phase 3 Endpoint Filter Design

**Status: design only. No code in this phase.**

This document specifies the read-side gate for the operational quarantine
columns added in [migration 037_jobs_archive.sql](../../migrations/037_jobs_archive.sql).
It is the second of the two deploys agreed to in v2 §4: schema first
(Phase 2), endpoint filtering second (Phase 3, this doc), with a soak
between.

Until Phase 3 endpoint changes ship, the migration is a behavioral no-op:
`hidden_from_ui DEFAULT false` means every existing row is visible to
every existing query. Phase 3 makes the visibility primitive load-bearing.

This is a design doc. No implementation in scope. No archive execution
path in scope. No production reads in scope.

---

## 1. Goals and non-goals

### Goals

1. Operator UI surfaces (job list, calendar, dashboard, customer detail)
   stop rendering archived rows by default.
2. Direct-by-ID lookups continue to resolve archived rows so admin
   audit pages, restore actions, and historical drill-down work.
3. Operational write paths (status changes, assignments, time tracking,
   cancellation) succeed against archived rows so recovery is trivially
   reversible.
4. Reports and analytics get a per-endpoint default that matches their
   purpose: "active business" reports exclude archived; "all-history"
   reports include them.
5. Rollback of Phase 3 alone (without rolling back the migration) is a
   single revert that restores prior behavior.

### Non-goals

- No automatic archiving. Phase 3 is read-side only. The flags get set
  by Phase 4 (apply script, separate deploy, separate sign-off).
- No new feature flag. The migration's `hidden_from_ui` column is the
  switch; endpoint changes implement the gate. No env var, no `lib/feature-flags`
  entry — Phase 3 ships once and stays on.
- No frontend redesign. The frontend already renders whatever the API
  returns; the gate is server-side.
- No new authorization model. Existing role check (`req.user.role`)
  determines admin behavior; no new roles introduced.

---

## 2. Endpoint filter strategy

Three categories, each with a fixed treatment.

### 2.1 Filter strategy primitive

The default filter is added to the Supabase query builder:

```js
// Default exclusion — uses idx_jobs_visible partial index
query = query.eq('hidden_from_ui', false);
```

`hidden_from_ui` is `NOT NULL DEFAULT false`, so `.eq(false)` covers
all currently visible rows. No `.or()` for NULL handling needed.

When `?include_archived=true` is honored:

```js
const includeArchived = req.query.include_archived === 'true';
if (!includeArchived) {
  query = query.eq('hidden_from_ui', false);
}
// otherwise: no filter — both archived and active rows returned
```

The conditional add — never a `.eq(true)` for archived-only — keeps
the partial index path hot for the common case while supporting the
mixed-result admin view.

### 2.2 Three categories

| Category | Default | `?include_archived=true` honored? | Admin role behavior |
|---|---|---|---|
| **A. Operator-facing list/aggregate** | exclude archived | yes | same as operator (admin can opt in via the param like anyone else) |
| **B. Customer-detail / contextual list** | exclude archived | yes | same as operator |
| **C. Direct-by-ID / write paths / cron** | NO FILTER | n/a | n/a |

The category dictates the default. The `?include_archived=true`
override is operator-controllable per request, not role-gated. Admin
visibility differs only on category-A endpoints used by admin pages,
which the frontend invokes with `include_archived=true` baked in.

---

## 3. Exact endpoint list

Enumerated against the current `.from('jobs')` call sites in
[server.js](../../server.js). Lines are anchors as of the current
working tree; verify before implementation.

### 3.1 Category A — must filter, override available

| Endpoint | Line | Rationale |
|---|---|---|
| `GET /api/jobs` | [2913](../../server.js#L2913) | Main list. Default operator view. |
| `GET /api/jobs/export` | [3712](../../server.js#L3712) | CSV export — same default as the list. |
| `GET /api/jobs/available-slots` | [4555](../../server.js#L4555) | Scheduling availability — archived rows must not block slots. |
| `GET /api/jobs/available-for-workers` | [4805](../../server.js#L4805) | Worker app feed — archived jobs are not bookable work. |
| `GET /api/jobs/imported/count` | [7699](../../server.js#L7699) | The "X imported jobs" badge — drops to zero post-archive, which is the desired UX signal. |

### 3.2 Category B — must filter, opt-in include for admin pages

| Endpoint / call site | Line | Rationale |
|---|---|---|
| Customer-detail "recent jobs" panel | [3592](../../server.js#L3592), [4335](../../server.js#L4335) | Admin may want to see archived in customer history. |
| Calendar / dashboard aggregates | [4750](../../server.js#L4750), [4836](../../server.js#L4836) | Calendar surface — archived rows clutter timeline view. |
| `GET /api/jobs/:jobId/assignments` | [29599](../../server.js#L29599) | Worker assignment lookups — archived rows must not appear in active worker queues. |

### 3.3 Category C — MUST NOT filter

These paths must continue to resolve archived rows.

| Endpoint / call site | Line | Why |
|---|---|---|
| `GET /api/jobs/:id` | [5044](../../server.js#L5044) | Direct lookup — admin restore page renders the "Archived" banner. |
| `POST /api/jobs/:id/cancel` | [6701](../../server.js#L6701) | Status write — must succeed against any row. |
| `POST /api/jobs/:id/convert-to-recurring` | [6881](../../server.js#L6881) | Implicit recovery action; converting to recurring also disqualifies via classifier. |
| `POST /api/jobs/:id/duplicate` | [7040](../../server.js#L7040) | Duplicate-from-archived is a recognized recovery pattern. |
| `POST /api/jobs/:id/start-time` / `end-time` | [24258](../../server.js#L24258), [24299](../../server.js#L24299) | Operational write — sets `start_time`, which is a SAFE_KEEP signal in subsequent runs. |
| `POST /api/jobs/:jobId/assign` / `assign-multiple` | [29386](../../server.js#L29386), [29663](../../server.js#L29663) | Same — assignment is operational. |
| Recurring billing cron | [server.js:386](../../server.js#L386), [server.js:389](../../server.js#L389) | Filters `is_recurring=true AND status='completed'`; classifier guarantees no `is_recurring=true` row is ever archived. Defensive add filter is acceptable but not required. |
| Payroll / ledger reads | various | Classifier rule (3) guarantees no `cleaner_ledger` row exists for an archived job. Payroll is naturally invisible to archive state. |

### 3.4 New endpoints introduced by Phase 3

These are admin tooling and may ship in Deploy B or in a follow-up.
Decide before Phase 3 build.

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /api/jobs/:id/restore` | Single-job restore — clears archive flags, returns updated row. | Owner or admin. |
| `POST /api/admin/jobs/restore-batch` | Batch restore by `archived_reason` (e.g. roll back a whole `zbc_*` batch). | Admin role only. |
| `GET /api/admin/jobs/archived` | List archived jobs with filters (batch_id, date range, customer). Pagination. | Admin role only. |

The first two are the mechanical inverses of Phase 4's apply step. The
third is convenience tooling; the CLI + a SQL editor cover most needs.

### 3.5 ZB sync adoption — separate touchpoint

[`zenbooker-sync.js findOrLink()`](../../zenbooker-sync.js#L419) — when
an existing SF job is adopted by a fresh ZB sync (matched by
`zenbooker_id` or natural key), if the matched row has
`archived_by_process = 'zb-cleanup'` and `hidden_from_ui = true`, the
adoption update must also clear the four archive flags.

Five-line change inside the existing adopt path, in the same UPDATE
that sets `zenbooker_id`. Without it, ZB re-sync (Phase 7) would
silently leave Spotless's still-live ZB jobs in archived state — the
operator's "the job is gone" complaint would be a sync that adopted
but didn't un-hide.

**This is the only Phase 3 change OUTSIDE server.js.** Scope it
explicitly in the ticket.

---

## 4. Operator override behavior — `?include_archived=true`

### 4.1 Surface area

Available on every Category A and B endpoint. The frontend opts in by
appending `?include_archived=true` to the request URL.

### 4.2 Response shape

When `include_archived=true` is honored, response rows include the
archive metadata so the frontend can render banners:

```json
{
  "id": 12345,
  "status": "completed",
  "...": "...",
  "archived_at": "2026-05-15T03:22:11Z",
  "archived_reason": "zbc_20260507T143022_a1b2c3",
  "archived_by_process": "zb-cleanup",
  "hidden_from_ui": true
}
```

The columns are already part of `SELECT *` after the migration runs,
so no projection changes needed in most endpoints. Endpoints that
project an explicit column list must add the four columns to the
projection — flag this in the implementation ticket.

### 4.3 Default behavior unchanged

Without the param, the response is byte-identical to today (modulo
the four extra columns that get returned by `SELECT *` even now).

### 4.4 Caching implications

If any endpoint sets explicit `Cache-Control` headers, the cache key
must include `include_archived` to avoid serving an admin's mixed
view to an operator. None of the Category A / B endpoints set
explicit cache headers today, so this is a forward-looking note.

---

## 5. Admin visibility rules

### 5.1 What "admin" means here

`req.user.role` already exists ([server.js:2947](../../server.js#L2947)
and elsewhere) — `'worker'` is the restricted role; everything else
is implicitly the operator/owner. There is no separate admin role
in the current model. Phase 3 does NOT add one.

### 5.2 Who sees what

| Surface | Role | Default | Override |
|---|---|---|---|
| `/jobs` list page | worker | excluded (worker is already filtered to assigned-jobs-only) | n/a |
| `/jobs` list page | owner | excluded | UI button "Show archived" → request with `?include_archived=true` |
| `/admin/archived-jobs` (new page, optional) | owner | included (`?include_archived=true` baked into the page's fetch call) | n/a |
| `/jobs/:id` direct page | any | included always (no filter on direct lookup) | n/a — frontend renders banner from response fields |
| Customer detail "recent jobs" | owner | excluded by default | "Show all history" toggle adds `?include_archived=true` |
| Calendar | owner | excluded — no override (visual clutter) | none |
| Reports / analytics | owner | per-endpoint default (see §7.3) | per-endpoint param |

### 5.3 Worker safety

Workers are already restricted by `team_member_id` filter at
[server.js:2964](../../server.js#L2964). Adding `hidden_from_ui = false`
to the same query is purely additive — no new authorization surface.

---

## 6. Rollback semantics

Three layers of rollback, each scoped to the failure mode it addresses.

### 6.1 Phase 3 deploy rollback (revert of code only)

If Phase 3 endpoint filtering causes problems and we need to revert
without touching data:

```bash
# revert the merge commit
git revert <phase-3-merge-sha>
git push origin main   # production deploy follows
```

After revert:
- Endpoint filters disappear.
- Archived rows reappear in operator UI.
- The `archived_at`, `archived_reason`, `archived_by_process`,
  `hidden_from_ui` columns remain in the database (added by Phase 2,
  not touched by this revert).
- No data loss. Re-deploying Phase 3 immediately re-hides the same
  set of rows.

This is the cheap rollback. Use it for any behavioral problem that
isn't a data correctness issue.

### 6.2 Phase 2 schema rollback (drop the columns)

Reverses migration 037 entirely via [`037_jobs_archive_down.sql`](../../migrations/037_jobs_archive_down.sql).
The down migration includes a safety check that emits a NOTICE if any
row currently carries archive state, warning of data loss in
`archived_at` / `archived_reason` / `archived_by_process`.

Sequence to fully roll back the project:

1. `git revert` Phase 3 endpoint filters (per §6.1).
2. Recover any archived rows via §6.3 below.
3. Run `037_jobs_archive_down.sql`.

Skip step 2 only if you are certain no row carries archive state, or
you accept the loss of the audit metadata.

### 6.3 Per-row recovery (during soak — the common case)

Three flavors, all idempotent:

**A. Single job — operator action via UI or curl:**

```sql
UPDATE jobs
   SET hidden_from_ui      = false,
       archived_at         = NULL,
       archived_reason     = NULL,
       archived_by_process = NULL
 WHERE id = :job_id
   AND archived_by_process = 'zb-cleanup';
```

The `AND archived_by_process = 'zb-cleanup'` guard ensures we only
recover what THIS project archived. Future archive features (`'manual'`,
`'cancellation_auto'`) have their own recovery tooling; they cannot
be accidentally restored by zb-cleanup recovery.

**B. Whole batch — operator command:**

```sql
UPDATE jobs
   SET hidden_from_ui      = false,
       archived_at         = NULL,
       archived_reason     = NULL,
       archived_by_process = NULL
 WHERE archived_reason = :BATCH_ID
   AND archived_by_process = 'zb-cleanup';
```

**C. Implicit recovery via ZB re-sync** (per §3.5): if a row gets
adopted by a fresh ZB sync, its archive flags get cleared as part of
the adoption update.

### 6.4 Post-soak physical-delete rollback

Out of scope for Phase 3. Documented in v2 §4 — backup tables
captured at delete time, restore via INSERT-from-backup in FK order.

---

## 7. Interaction with adjacent systems

### 7.1 Recurring jobs

**Cron path** ([server.js:384–442](../../server.js#L384)) reads
`is_recurring=true AND status='completed' AND next_billing_date <= today`.

The classifier guarantees no `is_recurring=true` row ever lands in
SAFE_ARCHIVE — predicate `is_recurring_self` blocks it. So no
archived row is ever a recurring billing parent.

**Defensive recommendation**: still add `.eq('hidden_from_ui', false)`
to the cron query, as belt-and-braces against future archive features
that don't have the same classifier guarantee. Cost: zero (the partial
index covers it). Benefit: future-proofs the cron against any archive
feature that might one day flag a recurring job.

**Recurring-converted jobs**: `POST /api/jobs/:id/convert-to-recurring`
is in Category C (no filter) — converting an archived job to recurring
implicitly recovers it (the conversion sets `is_recurring=true`, which
is a SAFE_KEEP signal in the next classifier run; the operator should
also explicitly clear the archive flags as part of the conversion's
UPDATE).

### 7.2 Conversations

`communication_conversations` links to customers via `customer_id`,
not to jobs directly. **No conversation row is broken or hidden by
archiving a job.**

But the customer-detail surface has a "recent jobs" panel that
queries `jobs WHERE customer_id = X`. That call is in Category B —
filtered by default, opt-in include for admin pages.

The Communications page's "linked job" panel (if/when it ships per
the Service Flow Obsidian note's "Communications Page" section)
should also be Category B — exclude archived by default, allow
opt-in.

### 7.3 Reports / analytics

Per-endpoint default by purpose:

| Report kind | Default | Override |
|---|---|---|
| "This week's revenue" / dashboard KPIs | exclude archived | n/a — operational dashboards are about active business |
| Payroll ([payroll.jsx](../../../service-flow-frontend/src/pages/payroll.jsx) backend reads) | no filter needed — classifier guarantees no ledger row on archived jobs | n/a |
| Job count by status | exclude archived | `?include_archived=true` for "all-time" rollups |
| Customer-history export | include archived | `?include_archived=false` for "active customers only" |
| Booking-Koala export endpoint | exclude archived | `?include_archived=true` to round-trip historical data |
| Tax / accounting exports | include archived | n/a — must show all historical rows |

The principle: "active business" defaults exclude; "historical /
audit" defaults include. Per-endpoint decision; the implementation
ticket should enumerate each report endpoint with its chosen default.

### 7.4 ZB sync (already covered §3.5)

### 7.5 LeadBridge integration

`lb_external_request_id` is set on jobs that came in via LB. The
classifier rule `lb_linked` makes those SAFE_KEEP — no LB-linked job
will ever be archived. No special handling needed.

`lb_outbound_outbox` references jobs by string ID. If a row is
archived but has a pending outbox entry, the classifier already
flagged it as SAFE_KEEP (see `lb_outbound_outbox_present` predicate).
So Phase 3 introduces no new LB interaction.

### 7.6 Stripe webhooks

Stripe webhook handlers update jobs by `id` (Category C — no filter
on direct ID). Payment events arriving on an archived job will
update `payment_status` etc. without issue. Defensive option: the
webhook handler could explicitly `restore` (clear archive flags)
when a payment lands — payment is a strong signal the job should
be active. **Recommended**: yes, add a 4-line auto-restore in the
payment webhook handler. Costs nothing; prevents the common "I sent
an invoice and now I can't find the job" failure mode.

### 7.7 Workers / mobile app

Workers see only their assignments via the existing
`team_member_id` filter. Adding `hidden_from_ui = false` is purely
additive. Workers cannot use `?include_archived=true` (no UI control);
even if they sent it, the API can choose to ignore the param for
worker role. **Recommended**: ignore the param for `role='worker'`.

---

## 8. Deploy sequencing

Per v2 §4 (already approved):

```
Deploy A — Phase 2 schema only (037_jobs_archive.sql)
  - additive columns + indexes only
  - no behavior change (hidden_from_ui DEFAULT false everywhere)
  - existing /api/jobs returns identical results
  - 1-day soak in staging, then prod
  - if anything goes wrong → run 037_jobs_archive_down.sql

Deploy B — Phase 3 endpoint filters (this design)
  - adds .eq('hidden_from_ui', false) to Category A + B endpoints
  - adds ?include_archived=true override
  - adds findOrLink un-archive logic in zenbooker-sync.js
  - optional new admin endpoints (§3.4)
  - 1-day soak in staging, then prod
  - if anything goes wrong → git revert (per §6.1)
```

Combined deploy is rejected. The migration is a behavioral no-op;
shipping it alone proves the schema is healthy before any code paths
depend on the new columns.

---

## 9. Testing requirements (pinned before Phase 3 ships)

Tests to add as part of Phase 3 implementation. Listed here so the
implementation ticket can be sized correctly.

### 9.1 Endpoint behavior tests

For each Category A endpoint:
- list returns only `hidden_from_ui = false` rows by default
- list returns both archived and active when `?include_archived=true`
- response shape includes `archived_*` columns when override is honored

For each Category B endpoint:
- same as Category A
- admin page's pre-baked `?include_archived=true` returns mixed results

For each Category C endpoint:
- archived row resolves at direct ID lookup
- write/update succeeds against archived row
- response includes `archived_*` columns so frontend renders banner

### 9.2 ZB sync adoption test

- New ZB sync run against an archived row clears the archive flags
  as part of the adopt update.
- Same run against an active row leaves all four columns alone.

### 9.3 Worker / role tests

- Worker role: `?include_archived=true` ignored; archived rows always
  excluded regardless of param.
- Owner role: `?include_archived=true` honored.

### 9.4 Index usage tests

- `EXPLAIN` against `/api/jobs` shows `idx_jobs_visible` is used.
- `EXPLAIN` against admin archived list shows `idx_jobs_archived`
  is used.

These can run against the staging DB (read-only `EXPLAIN ANALYZE`)
once a staging DB exists. Until then, against a synthetic fixture.

---

## 10. Open questions for sign-off before Phase 3 implementation

1. **Admin role**: confirm there is no separate admin role today. If
   one is being introduced for unrelated reasons (e.g. the SendGrid
   admin dashboard at `/admin`), Phase 3 should align rather than
   inventing its own gate.
2. **Stripe auto-restore (§7.6)**: include in Phase 3 or follow-up?
   Recommend include.
3. **`/api/admin/jobs/archived` endpoint (§3.4)**: ship in Phase 3 or
   defer? Recommend ship — it makes operator restore much easier than
   raw SQL.
4. **Worker role param ignore (§7.7)**: confirm the convention that
   worker role can never see archived rows. If workers ever need
   "history" view (unlikely), this becomes a per-page decision.
5. **Calendar override (§5.2)**: confirm calendar has NO `?include_archived`
   override. Operator who wants to see archived jobs on the calendar
   would have an unintuitive UX; safer to force "list view" for that.

Awaiting answers before the Phase 3 implementation ticket is written.
