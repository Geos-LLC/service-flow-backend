# Identity Graph Enforcement Roadmap

**Status:** Stage 1 (warn-only) ships in `feature/identity-graph-hardening`. Stages 2–4 are planned, gated on prior-stage metrics.
**Owner:** Identity v5 working group.
**Companion:** `integration-compliance-audit.md`, `cross-source-identity-reconciliation.md`, `new-integration-requirements.md`, `reconciliation-health-dashboard.md`.

This roadmap defines how the system progressively enforces the rule:

> **The identity graph is the source of truth for identity linkage. Integrations are adapters. CRM entities are projections. No code writes graph-owned surfaces outside the canonical writers.**

We move from observe → detect → block, in four stages, each gated by metrics from the previous one. No stage is reached automatically — each requires explicit operator approval.

---

## Stage 1 — Warn-only violations (CURRENT)

**Goal:** measure the size of the problem without changing behaviour.

**Posture:**
- `lib/identity-graph-violation.js` exports `emitViolation` + `recordTransitionalBypass`.
- Known transitional bypasses are wrapped (per `integration-compliance-audit.md` §2):
  - `server.js:maybeCreateLeadFromOpenPhone` (sf_lead_id direct write)
  - `server.js:merge_duplicate_customers` (converted_customer_id repointing)
  - `lib/identity-backfill.js:runIdentityBackfill` (apply-mode sf_* direct write)
- No code blocks. No errors thrown. Production behaviour is unchanged.
- Loki dashboards show counts per `kind=` + per `source=`.

**Observability:**
- `[IdentityGraphViolation] kind=<kind> tenant=<id> target=<col> source=<callsite> reason=<short> path=<call-stack>`
- Group D panels in `reconciliation-health-dashboard.md` track counts.

**Exit criteria (move to Stage 2 when ALL hold):**
1. 14 days of production data showing ZERO new unauthorised `kind=` values (i.e., only the known transitional bypasses + their tagged sources appear).
2. The complete list of bypassing call sites matches `integration-compliance-audit.md` §2 — no new sources discovered.
3. Operator has reviewed the Group D dashboard and confirmed each known bypass.
4. CI scanner (`scripts/check-identity-graph-bypass.js`) authored + passing in dry-run mode.

**Rollback:** Stage 1 is purely additive. Reverting `lib/identity-graph-violation.js` + the three call-site instrumentation hunks rolls back. Zero schema impact.

---

## Stage 2 — CI / static detection

**Goal:** prevent NEW direct writes from reaching `main` without explicit acknowledgement.

**Posture:**
- Promote `scripts/check-identity-graph-bypass.js` from dry-run to enforcing in CI (`npm run ci` / pre-merge hook).
- The scanner grep-scans the codebase for direct writes to:
  - `leads.converted_customer_id`
  - `leads.parent_lead_id`
  - `leads.lead_origin_type`
  - `communication_participant_identities.{sf_lead_id, sf_customer_id, last_hydrated_by, status}`
- Any match must be EITHER:
  - In the authorised-writers allowlist (`lib/identity-linker.js`, `lib/identity-resolver.js`, `leadbridge-service.js` createChildLeadFromLB).
  - Adjacent to a `recordTransitionalBypass(...)` or `emitViolation(...)` call AND have a matching entry in `integration-compliance-audit.md` §2.
- New unauthorised matches → CI fails with file:line + remediation message.

**Posture for live runtime:** still warn-only. Static check stops NEW code; runtime is observability-only.

**Implementation outline:**
- Scanner uses simple regex + file allowlist (no AST parsing needed at this stage).
- Allowlist is a YAML file `scripts/identity-graph-bypass-allowlist.yml` with sha-pinned hashes of the legitimate sites — moving an authorised write requires updating the allowlist (forces deliberate review).
- Add to `package.json` scripts: `"check:identity-graph": "node scripts/check-identity-graph-bypass.js --strict"`.
- Wire into `npm run ci`: `npm run guard:status && npm test && npm run check:identity-graph`.

**Exit criteria (move to Stage 3 when ALL hold):**
1. CI scanner has been enforcing for 30 days without false-positives.
2. Stage 1 dashboards (Group D) show zero unexpected `source=` values throughout that window.
3. All adapters in `integration-compliance-audit.md` §1 have reached at least "partially compliant" — no remaining "legacy bypass" status.
4. Operator sign-off on moving to runtime enforcement.

**Rollback:** Stage 2 is opt-in via the `--strict` flag. Reverting the flag returns the scanner to dry-run. Removing the `check:identity-graph` step from `npm run ci` is a one-line change.

---

## Stage 3 — Runtime hard blocks (non-test envs)

**Goal:** in production, refuse direct writes that bypass the linker.

**Posture:**
- `lib/identity-graph-violation.js` gains a `throwOnViolation` mode controlled by env var `IDENTITY_GRAPH_VIOLATION_THROW`:
  - Default OFF (Stages 1+2 behaviour preserved).
  - When ON, `emitViolation` THROWS instead of logging.
  - Test environments (`NODE_ENV=test`) always log-only; throwing in tests would surface as test failures but doesn't add safety.
- Wraps in `recordTransitionalBypass` are EXCEPT from throw — they remain warn-only because they're acknowledged + documented.
- Wraps in `emitViolation({ kind: 'direct_*' })` THROW under Stage 3.

**Rollout:** per-tenant via `IDENTITY_GRAPH_VIOLATION_THROW_TENANTS=<csv>` — same opt-in pattern as Stage 2 LB adapter. Tenant 2 first, soak 14 days, expand.

**Posture for CI:** Stage 2 scanner stays. Stages 2 and 3 are independent gates.

**Exit criteria (move to Stage 4 when ALL hold):**
1. Stage 3 enabled for every active tenant for 30 days with zero throw events that needed escalation.
2. All transitional bypasses in `integration-compliance-audit.md` §2 have either:
   - Been migrated to authorised writers, OR
   - Have an approved permanent exemption (rare; requires operator + architect sign-off).
3. Operator sign-off on dropping the bypass paths from code.

**Rollback:** clear `IDENTITY_GRAPH_VIOLATION_THROW` env. Runtime returns to Stage 2 (warn-only + CI-detected). Immediate; no restart required (env re-read per call).

---

## Stage 4 — Full adapter-only enforcement

**Goal:** the codebase has only authorised writers. Transitional code is removed.

**Posture:**
- Delete `lib/identity-backfill.js` (archive to `scripts/archive/identity-backfill-2026.js`).
- Delete `attemptScoringFallback` from `lib/identity-linker.js` + remove `IDENTITY_SCORING_FALLBACK_*` flags.
- Delete the warn-only instrumentation at the three known transitional sites (they've all been refactored or retired).
- `emitViolation` becomes alarm-only — its existence implies a serious bug.

**Rollout pattern:**
- One PR per removal: backfill removal → fallback removal → instrumentation removal.
- Each PR runs Stage 3 throw-mode for 14 days BEFORE removal lands, to prove no production traffic touches the path being removed.

**Posture for CI:** Stage 2 scanner stays, but now flags EVEN the `recordTransitionalBypass` callsites as errors (since transitional code is gone).

**Exit criteria:**
- Stage 4 is the terminal state. No further stages.

---

## 2. Cross-stage requirements

### Tenant gating

Every stage's enforcement is per-tenant where possible:

- Stage 1: global (warn-only is safe to run everywhere).
- Stage 2: global CI step (gates merge, not runtime).
- Stage 3: per-tenant via `IDENTITY_GRAPH_VIOLATION_THROW_TENANTS=<csv>`.
- Stage 4: global (deletion is by definition global).

### Emergency override

At any stage, the operator can disable enforcement:

- Stage 1: revert the emitter wraps (no impact on behaviour anyway).
- Stage 2: `npm run ci` can be run without `check:identity-graph` step (e.g., during incident).
- Stage 3: `IDENTITY_GRAPH_VIOLATION_THROW=false` or clear `IDENTITY_GRAPH_VIOLATION_THROW_TENANTS` — runtime returns to warn-only.
- Stage 4: the only override is `git revert` of the removal PR. There's nothing to disable because the code is gone.

### Observability requirements

Every stage requires the panels in `reconciliation-health-dashboard.md` Group D to be wired and watched:

- `kind=direct_*_write` counts → Stage 2 surfaces NEW violations.
- `kind=transitional_bypass` counts per `source=` → Stage 3 measures known-good paths.
- `kind=integration_bypass` counts → Stage 4 verifies removal.

If Group D panels aren't visible to the operator, no stage transition is approved.

### Rollback posture (cross-cutting)

- Stage 1 → Stage 0: revert the hardening PR. 0 risk (warn-only).
- Stage 2 → Stage 1: remove CI step. 0 risk.
- Stage 3 → Stage 2: clear env flag. Seconds; per-tenant.
- Stage 4 → Stage 3: `git revert` the removal PR. ~3 min deploy.

No stage transition is destructive at the data layer.

---

## 3. Stage status (as of 2026-05-22)

| Stage | Status | Notes |
|---|---|---|
| 1 — Warn-only | **READY for review** | `lib/identity-graph-violation.js` exists; 3 call sites instrumented; 25 emitter tests green |
| 2 — CI / static detection | designed; scanner sketched (`scripts/check-identity-graph-bypass.js`) | Awaiting Stage 1 soak before enabling `--strict` |
| 3 — Runtime hard blocks | designed only | Awaiting Stage 2 30-day clean window |
| 4 — Full adapter-only | designed only | Awaiting Stage 3 + complete adapter migration |

---

## 4. Cross-references

- Violation emitter: `lib/identity-graph-violation.js`
- CI scanner: `scripts/check-identity-graph-bypass.js`
- Compliance audit: `docs/architecture/integration-compliance-audit.md`
- Health dashboard contract: `docs/operations/reconciliation-health-dashboard.md`
- New-integration requirements: `docs/architecture/new-integration-requirements.md`
