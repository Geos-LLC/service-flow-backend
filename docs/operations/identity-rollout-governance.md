# Identity Reconciliation — Rollout Governance

**Status:** Active governance document
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-enforcement-roadmap.md](../architecture/identity-enforcement-roadmap.md) — code-level enforcement stages (warn → CI → runtime → adapter-only)
- [transitional-infrastructure-registry.md](../architecture/transitional-infrastructure-registry.md) — every transitional bypass enumerated
- [fallback-retirement-gates.md](../architecture/fallback-retirement-gates.md) — numeric thresholds for each retirement gate
- [identity-reconciliation-runbook.md](identity-reconciliation-runbook.md) — incident response

---

## 1. Why this document exists

The identity reconciliation refactor introduces durable architectural rules
(graph is authoritative, CRM is projection, integrations are adapters). Those
rules are necessary but not sufficient. Without a written rollout discipline
the team will:

- Flip flags on for tenants that aren't ready (no observation period, no
  rollback rehearsal).
- Treat dark code as production-validated just because it compiled.
- Conflate "tenant onboarded" with "tenant graduated" — and never retire the
  transitional fallback that was supposed to be temporary.

This doc defines:

1. **Rollout stages** — the gates a tenant must clear to advance from
   dark-code observation to engine-owned authority.
2. **Maturity score** — a per-tenant Bronze/Silver/Gold rating that
   determines what the engine is allowed to do for that tenant.
3. **Tenant contract** — what the platform promises tenants in each tier,
   and what we ask them to accept in return.
4. **Promotion + demotion rules** — explicit, reversible, observable.

> **Non-goal:** This document does not enable any tenant. It only defines
> how enablement must happen. No flag is flipped as a side effect of
> publishing this.

---

## 2. Rollout stages (per tenant)

A tenant moves through stages in order. The engine's per-tenant flag list
(`RECONCILIATION_ENGINE_<INTEGRATION>_TENANTS`) determines which stage
they're in.

| Stage | Name              | Engine code path | Production effect | Exit gate (to advance) |
|------|-------------------|------------------|-------------------|------------------------|
| S0   | Dark              | Not loaded       | None (legacy only) | Engine code merged, unit tests green, scanner clean |
| S1   | Dry-run           | Loaded, returns plan but executor=noop | None — plan logged for observability | 14d of plans logged, zero divergence vs legacy outcome |
| S2   | Shadow            | Loaded, executor writes plan to side-table only | None — plan persisted but not applied | 7d shadow writes with diff-vs-legacy logged, no novel failure modes |
| S3   | Co-pilot          | Engine path drives writes; legacy path retained as fallback if engine plan = `unknown` | Engine is the writer for ~95% of events; legacy fills the gap | 14d at ≥99% engine coverage AND zero engine-caused incidents |
| S4   | Authoritative     | Engine path only; legacy path removed for this integration | Engine writes 100%; legacy code is dead for this tenant | (terminal — graduation event) |

### Stage hygiene rules

- **No stage skipping.** A tenant cannot move from S0 to S3. Each gate is
  observational; skipping defeats the point.
- **Demotion is always allowed.** Any operator can demote a tenant by one
  stage at any time by removing them from the `_TENANTS` list — no
  approval required. (Promotion requires the gate.)
- **Demotion is announced, not silent.** When a tenant is demoted, emit an
  `[IdentityRollout] demoted` log line with tenant id + previous stage + reason.
- **Stages are integration-scoped, not tenant-scoped.** Tenant 2 can be at
  S3 on LB and S0 on OP simultaneously. Each integration carries its own
  `_TENANTS` flag.

### When a stage gate fails

If the metric required to advance a stage degrades during the soak window,
the soak clock resets. (No partial credit. No "rolling 14-day average" —
the window must be unbroken.)

If the metric degrades AFTER the tenant has advanced, demote them by one
stage. The post-demotion soak window starts fresh.

---

## 3. Tenant maturity score

Each tenant gets a per-integration maturity tier. The tier determines what
operations the engine is permitted to do for that tenant — independent of
the rollout stage.

### 3.1 Bronze

**Default tier for any new tenant.**

| Allowed | Refused |
|---------|---------|
| Engine dry-run / shadow / co-pilot (any rollout stage) | Engine authoritative writes that would replace ≥10 existing identity rows in a single batch |
| Identity row creation (`status='unmatched'`, `'resolved_lead'`, `'resolved_customer'`) | Cross-tenant merge proposals (engine never proposes these anyway, but Bronze cannot accept them even if surfaced) |
| Projection writes via `setIdentityLead` / `setIdentityCustomer` | Operator-override mode (`applyLeadCustomerLink({mode:'operator_override'})`) |
| Scoring fallback bridge IF the capability flag is on AND tenant is in `IDENTITY_SCORING_FALLBACK_TENANTS` | Retroactive identity repair (mass `last_hydrated_by` rewrites) |

**Promotion to Silver requires:** 30d in Bronze with zero P1 identity incidents AND ≥95% projection success rate AND identity-graph self-sufficiency ratio ≥ 0.80.

### 3.2 Silver

**For tenants past the burn-in.**

Adds to Bronze:

| Now allowed |
|-------------|
| Operator-override mode in projection-layer linker |
| Larger batch writes (up to 50 identity rows in a single engine plan) |
| Engine-proposed lead-customer linking for unlinked pairs with `confidence='high'` |

**Promotion to Gold requires:** 60d in Silver with zero P1/P2 identity incidents AND graph self-sufficiency ratio ≥ 0.95 sustained for 30d AND scoring fallback usage < 1% of events for that tenant.

### 3.3 Gold

**For tenants whose graph is provably self-sufficient.**

Adds to Silver:

| Now allowed |
|-------------|
| Engine-proposed lead-customer linking at `confidence='medium'` (still always reversible via `unlink_pair` operator action) |
| Bypass of scoring fallback bridge (capability flag effectively no-op for this tenant) |
| Retroactive identity repair runs (one-shot operator-initiated jobs to backfill historic `last_hydrated_by` values) |

Gold tenants are candidates for the eventual removal of the scoring
fallback code entirely (see `fallback-retirement-gates.md`).

### 3.4 Storage of maturity tier

Maturity tier is **not** stored in the database. It lives in operator
documentation + the `_TIER` env vars (e.g. `IDENTITY_MATURITY_GOLD=2,3`).
Reasons:

- Tier is a policy decision, not a fact about the tenant. Storing it in
  Postgres invites code branching on it, which couples behaviour to
  durable state and makes rollback harder.
- The set of Gold tenants is small and changes rarely (monthly at most).
  Env-var management is sufficient.
- Operator-visible: any team member can read `RAILWAY_ENV` and answer
  "what tier is tenant 2?" without a DB query.

---

## 4. Tenant contract

What we promise tenants, and what we ask them to accept.

### 4.1 Platform promises (all tiers)

- **No silent merges.** Identity rows are never silently combined. Every
  merge has an audit row in `identity_link_audit`.
- **No silent splits.** Identity rows are never silently split. Splitting
  is operator-initiated and always reversible within 7d.
- **Source-of-truth invariant.** A given (channel, normalized_phone) pair
  maps to exactly one identity row per tenant. Cross-tenant collisions
  are impossible (RLS + `user_id` scoping).
- **Reversibility.** Every projection write to `leads.converted_customer_id`,
  `customers.canonical_identity_id`, and the identity row's
  `sf_lead_id`/`sf_customer_id` is reversible within the audit log retention
  window (90d).

### 4.2 What we ask tenants to accept

- **Idempotency replaces "exactly-once".** When a webhook fires twice for
  the same event, the engine processes it twice; idempotency keys + the
  audit table prevent double-effects. Tenants should not assume each
  webhook is unique.
- **Engine refuses on ambiguity.** When the engine returns
  `kind: 'unknown'` or `confidence: 'low'`, no write happens. The tenant
  may see a transient "lead not yet attached to customer" state until
  human review or fresh source data resolves it.
- **Operator override is opt-in (Silver+).** Bronze tenants cannot use
  the merge/repoint operator endpoints — these are gated by tier.

### 4.3 What tenants can request

- **Tier promotion review.** Any tenant on Bronze for 30d+ can request a
  Silver eligibility review. Decision lives with identity-v5 owner.
- **Tier demotion.** Any tenant can request immediate demotion. Honored
  same-day. Demotion is announced via the `[IdentityRollout]` log channel
  for audit.
- **Maturity dashboard view.** Tenants on Gold get read access to their
  own maturity dashboard (graph self-sufficiency, projection success,
  fallback usage rate) for trust-building.

---

## 5. Promotion ritual

When a tenant advances a stage or tier:

1. Operator opens a PR titled `[Identity Rollout] Promote tenant <id> to <stage>/<tier>`.
2. PR description includes:
   - Current stage/tier
   - Target stage/tier
   - Metric proof (links to Grafana panels showing the gate was met)
   - Soak-window duration (must be unbroken — link to dashboard for the window)
   - Rollback plan (one paragraph; how we demote if the new tier misbehaves)
3. PR adds the tenant to the relevant `_TENANTS` env var (Railway
   config change, not code).
4. Two-person approval required (PR author + one other team member with
   identity-graph context).
5. Merge triggers a Railway deploy. The deploy itself does NOT change
   tenant behaviour until the env var propagates to the running service.
6. After deploy, operator monitors the tenant's dashboard for 24h before
   declaring the promotion stable.

---

## 6. Demotion ritual

Demotion is faster and lighter than promotion — by design.

1. Operator (any team member) removes the tenant from the relevant
   `_TENANTS` env var via Railway.
2. Railway restarts the service.
3. Operator logs the demotion in `#identity-ops` Slack:
   `Demoted tenant <id> from <previous tier> to <new tier>. Reason: <one line>.`
4. Tenant-visible behaviour reverts within ~30s of restart.

No PR required. No two-person approval. Demotion is a safety mechanism;
gating it would defeat the point.

---

## 7. Stage + tier matrix (per integration, snapshot 2026-05-22)

This is the truth-of-the-moment view. Update when env vars change.

| Tenant | LB stage | OP stage | ZB stage | SF stage | Maturity tier |
|--------|----------|----------|----------|----------|----------------|
| 1      | S0       | S0       | S0       | S0       | Bronze         |
| 2      | S0       | S0       | S0       | S0       | Bronze         |
| 3      | S0       | S0       | S0       | S0       | Bronze         |
| (...)  | S0       | S0       | S0       | S0       | Bronze         |

**Everyone is at S0/Bronze.** No tenant has been enabled in any
`_TENANTS` list. This is the intended state for the governance branch.

To enable a tenant, see [stage-2-rollout-checklist.md](stage-2-rollout-checklist.md).

---

## 8. What this doc does NOT do

- It does not enable any tenant.
- It does not change any default flag.
- It does not change which writers are authorised — that's the
  enforcement roadmap's job.
- It does not change the identity confidence thresholds — those live in
  `identity-reconciliation-engine.js` and require their own RFC to widen.

---

## 9. Review cadence

- **Quarterly:** Review the stage + tier matrix, prune tenants who
  haven't advanced and don't have a known reason.
- **After every P1 identity incident:** Re-read sections 5–6 to verify
  promotion/demotion paths were respected. If not, file a follow-up.
- **Annually:** Reconsider Bronze/Silver/Gold definitions in light of
  what the engine can now do safely. Tier definitions are not load-bearing
  code — adjust freely if the data justifies it.
