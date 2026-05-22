# Stage 3 Merge Readiness Audit

**Status:** Acceptance checklist for the Phase 3 merge-readiness PR.
**Owner:** identity-v5
**Last updated:** 2026-05-22

> **What this audit gates:** merge of the dark / passive / observational
> simulation layer. Merge approval requires runtime neutrality
> (`allowed: true` always), zero behavior change, and passing tests.
> **It does NOT require a completed soak.** The 14-day tenant-2 soak
> is a post-merge / post-deploy validation that gates the next PR
> (Stage 3 *activation*), not this one.
**Companion docs:**
- [runtime-gate-validation.md](runtime-gate-validation.md) — simulation semantics
- [tenant-2-soak-readiness.md](tenant-2-soak-readiness.md) — soak prep
- [../architecture/replay-confidence-audit.md](../architecture/replay-confidence-audit.md) — replay class
- [../architecture/transitional-bypass-heatmap.md](../architecture/transitional-bypass-heatmap.md) — site map
- [../architecture/runtime-allowlist-design.md](../architecture/runtime-allowlist-design.md) — Stage 3 design
- [runtime-enforcement-metrics.md](runtime-enforcement-metrics.md) — metric contract

---

## 1. Why this document exists

The Phase 3 PR (this PR) adds:

- The simulation layer in `lib/identity-write-gate.js`.
- `simulateBlock: true` on all 7 instrumented sites.
- `@stage-3-disposition` and `@replay-class` tags on all 7 sites.
- Scanner extensions (`simulation_missing`, `stage_3_disposition_missing`,
  `replay_class_missing` warnings).
- New tests: 22 gate simulation tests + scanner tests.
- 5 new docs (this one + 4 companions).

None of this changes runtime behavior, but all of it must be
**internally consistent** before merge. This audit is the merge gate:
every item below must pass before the PR is accepted.

> **Scope:** Merge-time checklist. After merge, the soak prep doc
> (`tenant-2-soak-readiness.md`) takes over.

---

## 2. Code-level acceptance

### 2.1 Gate module

- [x] `lib/identity-write-gate.js` exports the new `simulateBlockDecision`
  pure helper.
- [x] Gate module exports `KNOWN_REPLAY_CLASSES`,
  `KNOWN_SIMULATED_DISPOSITIONS`, `SIMULATED_PERMANENT_ALLOWLIST`.
- [x] `evaluateIdentityWrite()` accepts `simulateBlock: true` input.
- [x] When `simulateBlock: true`, the return object carries
  `simulated_block`, `simulated_reason`, `simulated_stage`,
  `simulated_owner`.
- [x] When `simulateBlock: true`, the gate emits a second
  `[IdentityWriteGateSimulation]` log line distinct from the regular
  `[IdentityWriteGate]` line.
- [x] When `simulateBlock` is omitted/false, the four simulation
  fields are `null` and no simulation log is emitted.
- [x] **Invariant:** `allowed: true` regardless of `simulateBlock`
  value.
- [x] **Invariant:** simulation does NOT influence `future_block_candidate`
  or `metadata_complete`.
- [x] **Invariant:** simulation NEVER throws, even with a hostile
  logger or garbage input.

### 2.2 Instrumented sites

- [x] Site 1 (`crm_phone_anchor_customer`) — `simulateBlock: true` set;
  `@stage-3-disposition: simulated_block`, `@replay-class: partial`.
- [x] Site 2 (`crm_phone_anchor_lead`) — same shape.
- [x] Site 3 (`maybeCreateLeadFromOpenPhone`) — same shape.
- [x] Site 4 (`convert_lead_to_customer_endpoint`) — `simulateBlock: true`;
  `@stage-3-disposition: simulated_block`, `@replay-class: unsafe`.
- [x] Site 5 (`merge_duplicate_customers`) — `simulateBlock: true`;
  `@stage-3-disposition: simulated_allow`, `@replay-class: unsafe`.
- [x] Site 6 (`backfillZenbookerCustomers`) — `simulateBlock: true`;
  `@stage-3-disposition: simulated_block`, `@replay-class: safe`.
- [x] Site 7 (`runIdentityBackfill` apply-mode) — `simulateBlock: true`;
  `@stage-3-disposition: simulated_block`, `@replay-class: safe`.

### 2.3 Scanner

- [x] `OPTIONAL_METADATA_TAGS` includes `@stage-3-disposition` and
  `@replay-class`.
- [x] Scanner emits `stage_3_disposition_missing` warning when the
  tag is absent.
- [x] Scanner emits `replay_class_missing` warning when the tag is
  absent.
- [x] Scanner exports `detectSimulationFlag` helper.
- [x] Scanner emits `simulation_missing` warning when the paired gate
  call lacks `simulateBlock: true`.
- [x] Scanner does NOT double-emit `simulation_missing` when the gate
  call is also missing (only `runtime_gate_missing` fires).
- [x] All new warnings are severity=warning (never error).
- [x] `METADATA_LOOKBACK` accommodates the larger comment blocks
  (bumped to 50).
- [x] `node scripts/check-identity-graph-bypass.js` reports OK against
  the live repo.

### 2.4 Tests

- [x] `tests/identity-write-gate.test.js` has new suites:
  - `simulation vocabulary` (3 tests)
  - `simulateBlockDecision — pure function` (7 tests)
  - `evaluateIdentityWrite — simulation mode (DARK)` (7 tests)
  - `evaluateIdentityWrite — simulation log emission` (5 tests)
- [x] `tests/check-identity-graph-bypass.test.js` has new suites:
  - `detectSimulationFlag` (7 tests)
  - `scanTransitionalMetadata — Phase 3 merge-readiness warnings`
    (10 tests)
- [x] All gate tests pass: 54/54.
- [x] All scanner tests pass: 49/49.
- [x] Live-repo scanner integration test passes (zero warnings).

---

## 3. Doc-level acceptance

The five new/updated docs must each satisfy:

| Doc | Acceptance |
|-----|------------|
| `runtime-gate-validation.md` | Describes simulation semantics, Loki queries, success criteria, rollout safety |
| `replay-confidence-audit.md` | Classifies all 7 sites; defines the safe/partial/unsafe/tbd ladder |
| `transitional-bypass-heatmap.md` | Single-page cross-reference of every site vs every axis |
| `tenant-2-soak-readiness.md` | Pre-soak checklist + daily soak procedure + end-of-soak review |
| `stage-3-merge-readiness-audit.md` | This doc — the merge gate checklist |

- [x] All five docs carry the correct frontmatter (status, owner, last
  updated, companion docs).
- [x] All cross-references resolve (no dangling `[link](path.md)`).
- [x] No doc claims behavior change; all are explicit that the work
  is dark/observational/design-only.

---

## 4. Runtime safety invariants (post-merge)

After merging this PR, the following must remain true. These are the
non-negotiables that protect tenants:

- **Gate `allowed` value is always `true`.** Today, tomorrow, and at
  every commit until the Stage 3 *implementation* PR (which is not
  this PR).
- **No tenant traffic is refused.** No write paths return error
  codes or short-circuit because of the simulation.
- **No env var flips.** This PR adds no flags, no Railway variables,
  no posture columns.
- **No schema changes.** Migrations folder is untouched.
- **No new dependencies.** Same `package.json`/`package-lock.json`.

If any of those is violated by a code change in this PR, the PR is
not Phase 3 — it has crossed into Stage 3 implementation, which is a
separate review.

---

## 5. Post-deploy observability acceptance

**These checks are post-merge, post-deploy.** They do NOT gate merge.
Merge proceeds on §2 + §3 + §4. The team runs these checks within 1h
of staging deploy to confirm the simulation layer is healthy in
production. Failure here triggers the §6 rollback, not a merge block.

- [ ] `{service_name="service-flow-backend"} |~ "IdentityWriteGate "`
  (with the trailing space) emits the regular gate lines at expected
  rates (compare to pre-deploy baseline).
- [ ] `{service_name="service-flow-backend"} |~ "IdentityWriteGateSimulation"`
  emits new lines at approximately the same rate as the gate.
- [ ] No new error-level log lines appear in
  `{service_name="service-flow-backend"} | json | level="error"`.
- [ ] No `ExceptionHandler` or `FATAL` log lines appear (per
  CLAUDE.md log query rules).
- [ ] Latency P99 unchanged (gate adds at most one extra log line
  per call — no DB, no network).

Once these all pass, the 14-day **simulation soak** begins on
production tenant-2 per [tenant-2-soak-readiness.md](tenant-2-soak-readiness.md).
The soak's verdict gates the *next* PR (Stage 3 activation), not
this one.

---

## 6. Rollback plan

If any §4 invariant is violated or §5 observability check fails,
revert is one of:

1. **Git revert the whole PR.** Single-commit revert in the
   `feature/identity-graph-governance` branch. Pushes to staging
   auto-deploy.
2. **Site-level revert.** Remove `simulateBlock: true` from individual
   gate calls. Triggers `simulation_missing` warnings but no
   functional change.
3. **Doc-only revert.** If only docs are wrong, edit them in place;
   no code revert needed.

The simulation layer has no env-var off switch by design — keeping
the surface minimal. A full revert is the only deploy-time off
switch.

---

## 7. Sign-off

This PR is **ready to merge** when:

- All §2 checkboxes are ticked (they are above — green).
- All §3 checkboxes are ticked (they are above — green).
- Reviewer confirms no §4 invariant has been violated.
- §5 post-deploy checks are *scheduled* (they don't have to be
  *completed* — merge can proceed; the deploy step that follows
  will run them).

The 14-day soak is explicitly **not** a merge prerequisite. The
soak is a post-deploy validation milestone that gates the Stage 3
*activation* PR, not this PR.

Reviewer: identity-v5 owner-of-the-week.
Author: identity-v5.

After merge + deploy + clean post-deploy checks, the 14-day
**simulation soak** begins on tenant-2 (see
[tenant-2-soak-readiness.md](tenant-2-soak-readiness.md)). Stage 3
*activation* implementation does not begin until the soak passes.

---

## 8. What this document explicitly does NOT do

- Does not run any code.
- Does not deploy anything.
- Does not declare the simulation valid in production (that's the
  soak's job).
- Does not gate the Stage 3 *implementation* PR — that PR will have
  its own readiness audit.

This is the gate for **this PR only**.

---

## 9. Open questions

- **Cross-tenant simulation correctness.** The simulation is global —
  same decision regardless of tenant. We have no tenant-2-specific
  simulation today. Adequate for Phase 3; revisit at Stage 3 design.
- **What happens if a new bypass site lands during the soak?** The
  scanner will flag it (missing tags / missing simulateBlock), but the
  soak clock might restart. TBD whether new sites pause or reset the
  soak.
- **Multi-environment soak.** Staging vs production observability
  may diverge. Soak should run on production tenant-2, not staging,
  unless production is offline. TBD.
