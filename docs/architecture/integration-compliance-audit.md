# Integration Compliance Audit — Identity Graph Authority

**Status:** Snapshot 2026-05-22. Re-run on every new integration or material change to an existing one.
**Owner:** Identity v5 working group.
**Companion:** `cross-source-identity-reconciliation.md`, `identity-enforcement-roadmap.md`, `new-integration-requirements.md`.

This document audits every code path that creates, updates, or links identity / CRM-projection rows against the canonical authority model:

```
Integrations  →  Adapters  →  Reconciliation Engine  →  Canonical Identity Graph  →  CRM Projections
```

Compliance classifications:

| Status | Meaning |
|---|---|
| **compliant** | Calls reconciliation engine or canonical writers exclusively. No direct graph/projection writes. |
| **partially compliant** | Resolver wired, but at least one write still bypasses the canonical writer. Has a documented migration target. |
| **legacy bypass** | Predates the graph; writes CRM projections directly with no resolver involvement. Must migrate. |
| **transitional** | Acknowledged bypass that's part of the migration toolkit (backfill, repair). Has a documented retirement criterion. |

---

## 1. Integration matrix

| # | Integration | Status | Reconciliation engine? | Bypasses projection? | Direct CRM write? | Migration target | Removal plan |
|---|---|---|---|---|---|---|---|
| 1 | **LeadBridge** (webhook + sync) | partially compliant | No (engine adapter is dark code on A4) | Goes through `setIdentityLead` / `setIdentityCustomer` (A1 setters) when resolver is on | `leads` row INSERT in `createLeadFromLB` / `createChildLeadFromLB` (authorised LB writers) | A4 Stage 2 adapter routes through engine | Legacy `resolveOrCreateLead` branch removed when engine flag globally on (Stage 2 retirement) |
| 2 | **Zenbooker** (webhook + sync) | compliant (with transitional bridge) | Resolver only (A1 hybrid: graph projection first, scoring fallback second, strict opt-in) | No (graph projection authoritative) | `customers` row INSERT in `upsertCustomerFromZB` (authorised ZB writer) | Fallback retires when graph self-sufficiency ratio ≥ 0.95 for 14d (see retirement criteria below) | Drop `attemptScoringFallback` + `IDENTITY_SCORING_FALLBACK_*` flags |
| 3 | **OpenPhone** (Sigcore webhook) | partially compliant | Resolver via `resolveParticipantMapping` (Phase C) | One direct identity-row write (`server.js:maybeCreateLeadFromOpenPhone`) — flagged as `transitional_bypass` | `leads` row INSERT in `maybeCreateLeadFromOpenPhone` (conditional) | Stage 4 (OP engine adapter) | Migrate `sf_lead_id` write to `setIdentityLead`; route OP lead creation through engine |
| 4 | **Sigcore** (platform: contact identity, OP wiring) | legacy bypass | No | Yes (Sigcore-side merges not yet propagated to SF identity graph) | No direct CRM write today, but its participant identifiers are read into `communication_participant_identities` outside the canonical setter path | Stage 5 (Sigcore engine adapter + `participant.merged` webhook) | Once Sigcore emits merge events SF consumes via engine; remove direct contact reads |
| 5 | **SMS / Twilio** | compliant | n/a (transport-only) | No identity/projection writes | No (only `communication_messages` / `communication_calls` — non-identity tables) | n/a | n/a |
| 6 | **Thumbtack / Yelp ingestion** | compliant via LeadBridge | Indirect via LB adapter | n/a (no direct SF path) | n/a | LB adapter migration covers it (A4) | n/a |
| 7 | **Manual SF creation** (`POST /api/leads`, `POST /api/customers`) | legacy bypass | No | Yes (no resolver call; no projection trigger) | Yes — direct `leads` / `customers` INSERT | Stage 4.5 manual adapter | Wrap with `engine.reconcile({source:'manual_sf'})`; return 422/409 on ambiguity for operator confirmation |
| 8 | **Identity Conflicts repair** (`POST /api/identity-conflicts/repair-lead-links`) | compliant | n/a (evidence-based, not scoring) | Goes through `applyLeadCustomerLink` (authorised operator path) | No (only via `applyLeadCustomerLink`) | Stays as operator-controlled override | n/a (operator path is part of canonical model) |
| 9 | **Identity Conflicts link** (`POST /api/identity-conflicts/:id/link-lead`) | compliant | n/a (operator override) | Goes through `applyLeadCustomerLink` | No | Stays | n/a |
| 10 | **Customer merge** (`POST /api/customers/.../merge-duplicates`) | transitional | n/a (operator-initiated) | Yes — direct `leads.converted_customer_id` repointing in `server.js:merge_duplicate_customers` (instrumented with `[IdentityGraphViolation] transitional_bypass`) | Yes (legitimate during customer-deletion merge) | Stays operator-controlled; instrumentation observes frequency | Migration would require a `mergeCustomers(supabase, logger, {sourceId,targetId})` primitive in the linker; not yet built |
| 11 | **Identity backfill** (`runIdentityBackfill` + scripts/phase1-*) | transitional | Yes — calls `resolveIdentity` strict mode | Yes — writes `sf_customer_id` / `sf_lead_id` directly to identity row (instrumented with `[IdentityGraphViolation] transitional_bypass`) | No (only identity-row writes; CRM projection comes from a separate phase) | Retire after every tenant is graph-complete | Archive `lib/identity-backfill.js` + `scripts/phase1-*` post-rollout |
| 12 | **Repair scripts** (`scripts/phase1-dryrun-repair.js`, `scripts/phase1-review-packet.js`) | transitional | Indirect via `applyLeadCustomerLink` (apply mode) | No | No (writes via canonical operator path) | Archive after Phase 1 completes for all tenants | Move to `scripts/archive/` |
| 13 | **Background sync jobs** (ZB cron, LB sync periodic) | compliant via ZB / LB rows | n/a (delegates to the integration's path) | No | No (just triggers ZB/LB sync functions) | n/a | n/a |
| 14 | **Future LB inbound `/lead-status` webhook** | compliant | Updates only `jobs.status` (constitution-allowed) | No | No (updateJobStatus is canonical) | n/a | n/a |
| 15 | **ZB outbound queue** (`zb-outbound-*`) | compliant (different scope) | n/a (financial / outbound; not identity) | No | No | n/a | n/a |

---

## 2. Current write-path graph

### Authoritative writers (do not flag)

| Surface | Authorised writer | File |
|---|---|---|
| `communication_participant_identities` row create/enrich | `resolveIdentity` (the only writer) | `lib/identity-resolver.js` |
| `communication_participant_identities.sf_lead_id` | `setIdentityLead` + `attemptScoringFallback` hydration | `lib/identity-linker.js` |
| `communication_participant_identities.sf_customer_id` | `setIdentityCustomer` + `attemptScoringFallback` hydration | `lib/identity-linker.js` |
| `communication_participant_identities.last_hydrated_by` | All authorised writers (provenance follows the write) | `lib/identity-linker.js` |
| `leads.converted_customer_id` | `projectIdentityToCRM` + `applyLeadCustomerLink` + `attemptScoringFallback` | `lib/identity-linker.js` |
| `leads.parent_lead_id` | `createChildLeadFromLB` | `leadbridge-service.js` |
| `leads.lead_origin_type` | `createLeadFromLB` + `createChildLeadFromLB` | `leadbridge-service.js` |
| `identity_link_audit` row insert | `writeAuditRow` | `lib/identity-linker.js` |

### Known transitional bypasses (instrumented warn-only)

| Site | Surface | Reason | Instrumentation |
|---|---|---|---|
| `server.js:maybeCreateLeadFromOpenPhone` | `communication_participant_identities.sf_lead_id` | OP path sets identity link directly after creating its own lead — predates `setIdentityLead`. Migration target: Stage 4 OP adapter. | `recordTransitionalBypass(kind=transitional_bypass, target=…sf_lead_id, source=server.js:maybeCreateLeadFromOpenPhone, reason=op_direct_identity_link)` |
| `server.js:merge_duplicate_customers` | `leads.converted_customer_id` | Operator-initiated merge re-points converted leads when source customer is about to be deleted. Refactor candidate. | `recordTransitionalBypass(kind=transitional_bypass, target=leads.converted_customer_id, source=server.js:merge_duplicate_customers, reason=operator_initiated_customer_merge)` |
| `lib/identity-backfill.js:runIdentityBackfill` | `communication_participant_identities.{sf_lead_id,sf_customer_id}` | Historic backfill writes the graph directly (no live source event to trigger a setter cascade). Migration tool; archive after rollout. | `recordTransitionalBypass(kind=transitional_bypass, target=…sf_lead_id/sf_customer_id, source=lib/identity-backfill.js:runIdentityBackfill, reason=historic_backfill_apply_mode)` — emitted once per backfill run |

---

## 3. Re-audit procedure

When a new integration is added or an existing one materially changes:

1. Grep the codebase for direct writes to graph-owned columns:
   ```bash
   grep -rn "converted_customer_id\s*[:=]" lib/ server.js *.js
   grep -rn "parent_lead_id\s*[:=]"      lib/ server.js *.js
   grep -rn "sf_lead_id\s*[:=]\|sf_customer_id\s*[:=]" lib/ server.js *.js
   grep -rn "lead_origin_type\s*[:=]"     lib/ server.js *.js
   ```
2. Compare against the "Authorised writers" list in §2.
3. For every new direct write outside the authorised set, the integration must EITHER:
   - Migrate to use an authorised writer, OR
   - Add a `recordTransitionalBypass(...)` call with `source=`, `target=`, `reason=` AND a documented migration target.
4. Update this audit's §1 matrix and §2 transitional-bypass table.
5. Run `node scripts/check-identity-graph-bypass.js` (CI scanner) — it asserts every direct write outside the allowlist has an `emitViolation` adjacent call.
6. Re-run the full Jest suite.

---

## 4. Cross-references

- Architectural model: `docs/architecture/cross-source-identity-reconciliation.md`
- Enforcement stages: `docs/architecture/identity-enforcement-roadmap.md`
- New-integration contract: `docs/architecture/new-integration-requirements.md`
- Operational metrics: `docs/operations/reconciliation-health-dashboard.md`
- Violation emitter: `lib/identity-graph-violation.js`
- CI scanner: `scripts/check-identity-graph-bypass.js`
