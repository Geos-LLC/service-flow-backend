# Identity Rollout Recovery — Safety Audit Snapshot (2026-05-22)

**Status:** Pre-recovery snapshot. Read-only. Captured before any branch/commit/migration action.
**Scope:** Records the verified state of code, git, and prod schema at the moment the recovery task began, so the recovery itself is auditable and reversible.

---

## 1. Git state at snapshot time

```
Branch:                main
HEAD:                  c658bff3b62ead1f67c7c32f06c6700f217baf7c
origin/main:           c658bff3b62ead1f67c7c32f06c6700f217baf7c     (local main in sync)
Local commits ahead:   0
Local commits behind:  0
```

### Last 5 origin/main commits (in order)

```
c658bff feat(identity): auto Lead ↔ Customer reconciliation on sync + retroactive repair
da7ce2f feat(identity): delete-owner + combine (merge) actions
841a85a feat(sms): 'Keep separate' resolution now bypasses SMS integrity STRICT block
d84c1b5 feat(identity): enrich conflict owners with name + external_source + full phone
c2051dd feat(identity): P0.1 phone identity registry + collision detector
```

### `git status` — modified tracked files (9)

```
M identity-conflicts.js
M leadbridge-service.js
M lib/feature-flags.js
M lib/identity-linker.js
M lib/lb-ingestion.js
M server.js
M tests/identity-linker.test.js
M tests/lb-ingestion.test.js
M zenbooker-sync.js
```

`git diff --stat HEAD` net delta: **9 files, +1740 / −995** (= +745 net).

### `git status` — untracked files, grouped by provenance

**Stage 1 (this session — engine skeleton):**
- `lib/identity-reconciliation-engine.js`
- `tests/identity-reconciliation-engine.test.js`
- `docs/architecture/identity-graph-refactor-plan.md`
- `docs/architecture/identity-reconciliation-engine-design.md`
- `docs/architecture/materialization-audit.md`
- `docs/architecture/sigcore-integration-audit.md`

**Stage 2 (this session — LB engine adapter):**
- `lib/lb-engine-adapter.js`
- `tests/lb-engine-adapter.test.js`
- `tests/lb-engine-rollout.test.js`
- `docs/architecture/stage-2-leadbridge-adapter-plan.md`
- `docs/operations/stage-2-rollout-checklist.md`

**Phase 0.5 (prior session — lead cardinality):**
- `lib/lead-aggregation.js`
- `lib/retroactive-repair-guards.js`
- `tests/lb-child-lead.test.js`
- `tests/lead-aggregation.test.js`
- `tests/retroactive-repair-guards.test.js`
- `migrations/049_lead_parent_lead_id.sql`
- `migrations/049_lead_parent_lead_id_down.sql`
- `docs/architecture/lead-cardinality-and-parent-lead-id.md`

**Phase 0 (prior session — projection-layer linker):**
- `migrations/048_identity_link_audit.sql`
- `migrations/048_identity_link_audit_down.sql`
- `docs/architecture/cross-source-identity-reconciliation.md`
- `docs/operations/identity-reconciliation-runbook.md`

**Operator scripts (Phase 1-era identity tooling — referenced from runbook):**
- `scripts/phase1-dryrun-repair.js`
- `scripts/phase1-review-packet.js`
- `scripts/output/phase1-review-packet.json`
- `scripts/output/phase1-review-packet.md`

**Orthogonal to identity work (excluded from identity recovery):**
- `scripts/dangling-batch-audit.js` (ledger)
- `scripts/reconcile-job-batch.js` (ledger)
- `scripts/repair-job-ledger-apply.js` (ledger)
- `scripts/repair-job-ledger-dry-run.js` (ledger)
- `scripts/repair-job-ledger-option-a-build.js` (ledger)
- `scripts/zb-financial-drift-audit.js` (ZB financial)
- `scripts/zb-status-drift-audit.js` (ZB status)
- `scripts/zb-status-drift-split-and-verify.js` (ZB status)
- `docs/architecture/job-create-contract-discovery.md` (ZB outbound)

---

## 2. Railway production deploy state (verified via Railway GraphQL API)

| Field | Value |
|---|---|
| Project | `Service Flow server` (`672437e4-9791-43c4-aa01-5181f3bd1904`) |
| Environment | `prod` (`31371339-0521-4d17-8ce8-28f5dc7c8423`) |
| Service | `service-flow-backend` (`eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7`) |
| Latest deploy ID | `ec12c254-b910-435d-a94a-ddf4090d846e` |
| Deploy status | `SUCCESS` |
| Deploy commit | `c658bff3b62ead1f67c7c32f06c6700f217baf7c` |
| Deploy commit message (1st line) | `feat(identity): auto Lead ↔ Customer reconciliation on sync + retroactive repair` |
| Deploy timestamp | 2026-05-21T22:14:49Z |
| Static URL | `service-flow-backend-production-4568.up.railway.app` |

### Production env-var state (selected identity flags)

| Variable | Value |
|---|---|
| `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` | `<unset>` |
| `RECONCILIATION_ENGINE_LEADBRIDGE` (global) | `<unset>` |
| `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` | `<unset>` |
| `IDENTITY_RESOLVER_LEADBRIDGE` (global) | `"1"` (globally ON) |
| `IDENTITY_RESOLVER_OPENPHONE` (global) | `"1"` |
| `IDENTITY_RESOLVER_ZENBOOKER` (global) | `"1"` |
| `OPENPHONE_CONDITIONAL_LEAD_CREATION` | `"1"` |
| `IDENTITY_BACKFILL_ENABLED` | `"1"` |
| `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` | `<unset>` |
| `LEAD_CARDINALITY_CHILD_LEADS` (global) | `<unset>` |
| `IDENTITY_PROJECTION_FREEZE` | `<unset>` |
| `ZB_OUTBOUND_GLOBAL_FREEZE` | `"true"` (P0 lockdown, orthogonal) |

**Observation:** several identity-resolver flags are globally ON in prod env, but the corresponding code paths only exist in the working tree, not in the deployed commit. This is an orphaned env-state — the flags exist but reference no live code beyond Phase A.

---

## 3. Production Supabase schema state (verified via Supabase Management API)

Project ref: `ezyhbvskbwmwgwyduqpt`.

### Migration target objects

| Schema object | Exists in prod? | Created by |
|---|---|---|
| `public.identity_link_audit` (table) | **NO** | `migrations/048_identity_link_audit.sql` (untracked in WT) |
| `public.leads.parent_lead_id` (column) | **NO** | `migrations/049_lead_parent_lead_id.sql` (untracked in WT) |
| `public.leads.lead_origin_type` (column) | **NO** | `migrations/049_lead_parent_lead_id.sql` |
| `public.leads.canonical_lead_id` (column, generated) | **NO** | `migrations/049_lead_parent_lead_id.sql` |

### Positive controls — what IS present in prod

| Schema object | Exists in prod? |
|---|---|
| `public.leads` | YES |
| `public.customers` | YES |
| `public.communication_participant_identities` | YES |
| `public.communication_identity_ambiguities` | YES |
| `public.communication_openphone_lead_decisions` | YES |
| `public.communication_participant_mappings` | YES |
| `public.identity_conflicts` | YES |
| `public.phone_identity_registry` | YES |
| `public.leads.id` | YES |
| `public.leads.converted_customer_id` | YES |
| `public.leads.source` | YES |
| `public.leads.lead_cost` | YES |

### Migration files in HEAD (origin/main)

```
migrations/038_push_subscriptions.sql
migrations/039_ledger_drift_audit.sql
migrations/040_zb_sync_dirty.sql
migrations/041_zb_apply_payment_writes.sql
migrations/042_delivery_log.sql
migrations/043_customer_files.sql
migrations/044_zb_outbound_commands.sql
migrations/045_team_member_provider_mappings.sql
migrations/046_phone_identity_registry.sql
migrations/047_identity_combine_rpcs.sql
```

Highest applied/tracked migration in HEAD: **047**. Migrations **048 and 049 exist only in the working tree (untracked) and are NOT applied to prod Supabase.**

---

## 4. Symbol-presence audit (HEAD vs working tree)

| Symbol | HEAD occurrences | WT occurrences | Required by Stage 2 |
|---|---|---|---|
| `setIdentityLead` | 0 | 5 (lib/identity-linker.js) + 6 (leadbridge-service.js) + 3 (server.js) | YES |
| `setIdentityCustomer` | 0 | 7 (lib/identity-linker.js) + 4 (leadbridge-service.js) + 1 (server.js) | YES |
| `projectIdentityToCRM` | 0 | 6 (lib/identity-linker.js) | YES (cascade) |
| `writeAuditRow` | 0 | 6 (lib/identity-linker.js) | YES (audit writes) |
| `emitProjectionMetric` | 0 | 33 (lib/identity-linker.js) | YES (`[IdentityLink]` log) |
| `applyLeadCustomerLink` | 2 (HEAD scoring impl) | 3 (WT projection impl) | YES (operator override; bodies differ) |
| `attemptLeadToCustomerLink` | 2 (HEAD) | 0 (removed in WT) | NO (replaced) |
| `emitIdentityLinkLog` | 5 (HEAD) | 0 (replaced) | NO |
| `scoreMatch` | (HEAD) | 0 (removed) | NO |
| `nameSimilarity` | (HEAD) | 0 (removed) | NO |
| `classifyChannel` | (HEAD) | 0 (removed) | NO |
| `assertCreateLeadInvariant` | 2 (HEAD lb-ingestion) | 2 (WT lb-ingestion) | YES |
| `assertCreateChildLeadInvariant` | 0 | 2 (lib/lb-ingestion.js) | YES (engine R5 + adapter grandchild path) |
| `createLeadFromLB` (closure) | 4 (HEAD leadbridge-service) | 7 (WT — reactivation-aware) | YES |
| `createChildLeadFromLB` (closure) | 0 | 3 (WT leadbridge-service) | YES |
| `enrichLeadFromLB` (closure) | 5 | 6 | YES |
| `resolveOrCreateLeadViaEngine` | 0 | 3 (WT leadbridge-service) | YES (added in Stage 2) |

### Importers of `lib/identity-linker` in HEAD

```
identity-conflicts.js : imports { attemptLeadToCustomerLink, applyLeadCustomerLink }
zenbooker-sync.js     : imports { attemptLeadToCustomerLink }
```

(Note: `server.js` and `leadbridge-service.js` do NOT import the linker in HEAD. They DO in WT, as part of Phase 0 projection-layer wiring.)

### Importers of `lib/identity-linker` in WT

```
server.js              : imports { setIdentityCustomer, setIdentityLead, applyLeadCustomerLink }
leadbridge-service.js  : imports { setIdentityLead, setIdentityCustomer }
identity-conflicts.js  : rewritten — no longer imports attemptLeadToCustomerLink
zenbooker-sync.js      : rewritten — uses setIdentityCustomer instead of attemptLeadToCustomerLink
```

---

## 5. Memory-state cross-check

The repository memory store at `C:\Users\HP\.claude\projects\c--Users-HP-Desktop-Projects-Active-Development-service-flow\memory\` contains entries that claim Phase 0 / Phase 0.5 / Phase B / Phase C / Phase D / Phase E / Phase F / Phase G are "shipped":

- `project_identity_unification_v4.md` (created 2026-04-04, last verified-against-state: never) — claims Phases A–G shipped to staging.
- `project_identity_v5_rollout.md` (created 2026-05-21) — claims Phase 0 and Phase 0.5 shipped 2026-05-21 with all flags OFF.

**Cross-check against this audit:**

| Memory claim | Audit finding |
|---|---|
| Phase A (resolver + ambiguities) applied to Supabase | ✅ Confirmed — both tables present in prod |
| Phase 0 (projection-layer linker) shipped 2026-05-21 | ❌ False — HEAD has scoring-based linker, not projection-layer |
| Phase 0.5 (parent_lead_id + child-leads) shipped 2026-05-21 | ❌ False — column does not exist in prod, code not in HEAD |
| Migration 048 (identity_link_audit) applied | ❌ False — table absent |
| Migration 049 (leads.parent_lead_id) applied | ❌ False — column absent |
| Phase B / C / D (LB/OP/ZB resolver-routed ingest) shipped to staging | ❌ False — leadbridge-service.js + server.js + zenbooker-sync.js modifications uncommitted |

**Root cause of drift:** memory entries were authored describing intent + local working-tree state at the time of writing, without re-verification against `origin/main` + Supabase schema. They were written as if the work that existed in the working tree had been committed and deployed. It was not.

**Corrected wording for these entries is drafted in `docs/architecture/memory-state-correction-plan.md` (sibling document). Memory itself is NOT updated by this task.**

---

## 6. Recovery decision

Path A confirmed by operator on 2026-05-22:

1. Audit (this document) ✅
2. Move all identity-related working-tree work to a non-default WIP branch.
3. Restore `main` to exactly `origin/main`.
4. Construct a four-link branch chain `main → A1 (Phase 0) → A2 (Phase 0.5) → A3 (Stage 1) → A4 (Stage 2)`.
5. Verify each branch independently.
6. Stage memory-correction proposal (not applied).
7. Deliver final rollout graph.

**Explicit non-actions for this task (hard constraints):**

- No deploy.
- No merge to `main`.
- No migration applied to prod Supabase.
- No flag flipped in prod env.
- No memory file updated.
- No phases bundled together in a single commit.
- No squash that loses provenance.

---

## 7. Rollback of this recovery (if needed)

If the recovery itself goes wrong:

1. **WIP branch protects everything.** All identity work lives on `wip/identity-graph-stage-1-2-and-deps` after Step 1. Even if the local main is corrupted, `git checkout wip/identity-graph-stage-1-2-and-deps` restores the snapshot.
2. **No prod state is touched** by this recovery — Railway env vars, Supabase schema, and `origin/main` are all left untouched until a separate operator-approved deploy task.
3. **Local main restore is non-destructive** because origin/main is the authority — if local `main` is in any unexpected state, `git fetch && git reset --hard origin/main` recovers it byte-for-byte.

---

## 8. Pointers

- Memory correction plan: `docs/architecture/memory-state-correction-plan.md` (drafted, not applied).
- Stage 2 plan: `docs/architecture/stage-2-leadbridge-adapter-plan.md`.
- Stage 2 rollout checklist: `docs/operations/stage-2-rollout-checklist.md`.
- Identity-graph refactor plan: `docs/architecture/identity-graph-refactor-plan.md`.
- Engine design: `docs/architecture/identity-reconciliation-engine-design.md`.
- Cross-source reconciliation reference: `docs/architecture/cross-source-identity-reconciliation.md` (Phase 0/0.5 design — currently uncommitted).
- Lead cardinality reference: `docs/architecture/lead-cardinality-and-parent-lead-id.md` (Phase 0.5 design — currently uncommitted).
- Identity runbook: `docs/operations/identity-reconciliation-runbook.md` (currently uncommitted).
