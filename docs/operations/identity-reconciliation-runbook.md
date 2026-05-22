# Identity Reconciliation Runbook

**Status:** Phase 0 shipped. Phase 0.5 design pending. Phase 1+ require operator approval.
**Companion to:** [docs/architecture/cross-source-identity-reconciliation.md](../architecture/cross-source-identity-reconciliation.md).

This runbook is the only authorized rollout procedure. Deviation requires operator written approval.

---

## 1. Pre-flight checklist (before any tenant enablement)

| Check | How to verify | Required |
|---|---|---|
| Phase 0 code deployed | `git log --grep "Phase 0 — identity"` shows Phase 0 commit on `staging` | ✓ |
| Audit table exists | `SELECT 1 FROM identity_link_audit LIMIT 1` succeeds | ✓ |
| Freeze switch responds | Set `IDENTITY_PROJECTION_FREEZE=true` on staging, hit a test endpoint, confirm Loki shows `outcome=freeze` | ✓ |
| All resolver flags OFF in prod | `railway variables --service service-flow-backend-production \| grep IDENTITY` returns no positive values | ✓ |
| Phase 0.5 (`parent_lead_id`) merged | `\d leads` shows `parent_lead_id` column | Required before Phase 3 |
| Audit Task 10 review signed off | Operator written approval | Required before Phase 3 |
| Grafana panels populating | All 8 metrics from §3 below show data when projection events fire | Required before Phase 3 |

---

## 2. Phase-by-phase procedure

### Phase 0 — code lands dark (DONE)

No procedure. Code lives in prod with all flags OFF. Zero behavior change.

### Phase 0.5 — lead cardinality (`parent_lead_id` + reactivation)

Code shipped 2026-05-21. Flags default OFF. Net prod behavior unchanged.

Apply procedure when ready to enable for a tenant (gated, do not enable globally):

```bash
# 1. Verify migration 049 is applied
psql $SUPABASE_URL -c "\d leads" | grep -E "parent_lead_id|lead_origin_type|canonical_lead_id"

# 2. Smoke test on staging (NO tenant flag flip needed for code to be exercised — just confirm shape)
curl -X GET 'STAGING/api/leads?include_children=true' -H 'Authorization: Bearer <staging JWT>'

# 3. Set the child-leads flag for the tenant FIRST (before any resolver flag)
railway variables --service service-flow-backend-production --set LEAD_CARDINALITY_CHILD_LEADS_TENANTS=2

# 4. Force redeploy and verify the var is live
curl -s ".../api/identities/status" -H 'Authorization: Bearer <jwt>'  # any authenticated endpoint to confirm boot
```

**Critical flag-flip order:**

For tenant `T`, when enabling identity resolution end-to-end (eventually in Phase 3):

```
1. LEAD_CARDINALITY_CHILD_LEADS_TENANTS         add T   # MUST be first
2. IDENTITY_RESOLVER_LEADBRIDGE_TENANTS         add T   # after step 1 verified
3. IDENTITY_RESOLVER_ZENBOOKER_TENANTS          add T
4. IDENTITY_RESOLVER_OPENPHONE_TENANTS          add T   # Phase 4
5. IDENTITY_REPORTING_UI_TENANTS                add T   # Phase 4 / 5
```

If step 2 happens before step 1, the **first repeat-LB event** for tenant `T` enriches the canonical lead and the acquisition record is lost permanently. Step 1 is the hard prerequisite.

To verify after step 1: send a test LB webhook for tenant `T` with phone matching an existing canonical lead. Confirm:
- A new `leads` row exists with `parent_lead_id = canonical.id`, `lead_origin_type = 'repeat_acquisition'`
- Canonical row's `source` / `lead_cost` / `created_at` unchanged
- Identity row's `sf_lead_id` still points at canonical
- Loki shows `[LeadCardinality] event=child_created tenant=T parent=… child=… identity=…`

Rollback (per tenant): remove `T` from `LEAD_CARDINALITY_CHILD_LEADS_TENANTS`. Any existing children remain valid leads — the column is additive, the rows are useful.

### Phase 1 — dry-run retroactive report (user_id=2 only)

**Goal:** see how many historical lead↔customer pairs would link, without writing anything.

```bash
# From operator's machine, authenticated as user_id=2:
curl -X POST 'https://service-flow-backend-production-4568.up.railway.app/api/identity-conflicts/repair-lead-links' \
  -H 'Authorization: Bearer <JWT>' \
  -H 'Content-Type: application/json' \
  -d '{ "dryRun": true, "limit": 500, "activeWindowHours": 24 }'
```

**`activeWindowHours` (default 24)** is a retroactive-repair operational safeguard. If both
the lead and the customer were `updated_at` within this window of now, the candidate is
downgraded from HIGH → `review_required` and is NOT auto-applied. This prevents collision
with an operator who is concurrently editing those rows during the cleanup window.

Set `activeWindowHours: 0` to disable. The safeguard does **not** apply to live ingestion
paths — only this retroactive sweep. See `lib/retroactive-repair-guards.js`.

Verdict tiers in the response:

| Tier | Auto-apply on `dryRun:false`? | Meaning |
|---|---|---|
| `high` | Yes (and only HIGH) | All 8 conservative gates passed, both sides idle longer than `activeWindowHours` |
| `review_required` | No | Would have been HIGH but both sides recently active — operator must verify |
| `medium` | No | Strong match but source incompatible OR phone-only-no-name match |
| `low` | No | Weak name / conflict / no phone match |
| `skipped` | No | Multi-owner conflict, lead already converted, lead/customer missing |

Response shape:

```json
{
  "ok": true,
  "dryRun": true,
  "total_conflicts_examined": 27,
  "high": 14,
  "medium": 6,
  "low": 2,
  "applied": 0,
  "refused": 0,
  "skipped": 5,
  "results": [
    {
      "conflict_id": 123,
      "lead_id": 67, "customer_id": 23421,
      "normalized_phone": "3013272882",
      "confidence": "high",
      "reason": "phone_match+strong_exact+source_compat",
      "name_class": "strong_exact",
      "phone_match": true,
      "source_compat": true,
      "lead_source": "Thumbtack Tampa",
      "customer_source": "Spotless Homes Tampa (thumbtack)"
    }
  ]
}
```

**Operator review:** manually validate 5 HIGH candidates by:
1. Open Identity Conflicts UI in browser.
2. Find the row by `conflict_id`.
3. Verify the lead and customer are visibly the same person.
4. Sample 2 MEDIUM candidates and verify they're genuinely ambiguous.

If any HIGH candidate is wrong, **stop**. Investigate why `classifyNameMatch` returned strong. Most likely: typo similarity or recycled phone. Add an exclusion or tune the resolver before proceeding.

### Phase 2 — apply HIGH-confidence repairs (user_id=2)

```bash
curl -X POST '.../api/identity-conflicts/repair-lead-links' \
  -H 'Authorization: Bearer <JWT>' \
  -H 'Content-Type: application/json' \
  -d '{ "dryRun": false, "limit": 500 }'
```

Watch in Loki:

```logql
{service_name="service-flow-backend"} |= "[IdentityLink]"
  | event="retroactive_apply"
  | tenant="2"
```

Spot-check 10 linked leads in the UI. Confirm:
- Lead source preserved (not overwritten).
- Lead `created_at` preserved.
- Customer's first/last_name preserved.
- `converted_at` is now() — not the lead's original date.

Hold 24h. Watch counter ratios in §3.

### Phase 3 — enable live resolver for user_id=2

Set Railway variables (service `service-flow-backend-production`, env `production`):

```
IDENTITY_RESOLVER_ZENBOOKER_TENANTS=2
IDENTITY_RESOLVER_LEADBRIDGE_TENANTS=2
```

Force-redeploy. Wait 48h. Verify counter ratios from §3 stay within red lines.

### Phase 4 — enable OpenPhone for user_id=2

```
IDENTITY_RESOLVER_OPENPHONE_TENANTS=2
OPENPHONE_CONDITIONAL_LEAD_CREATION=true   # NOTE: global, no per-tenant variant yet
IDENTITY_REPORTING_UI_TENANTS=2
```

If `OPENPHONE_CONDITIONAL_LEAD_CREATION` needs to be per-tenant later, add the tenant-list variant to feature-flags.js.

### Phase 5 — per-tenant rollout

For each additional tenant `T`:
1. Repeat Phase 1 dry-run for `T`.
2. Phase 2 apply for `T`.
3. Append `T` to each `IDENTITY_RESOLVER_*_TENANTS` env var.
4. Force-redeploy.
5. Soak 48h before moving to next tenant.

**Never:**
- Set `IDENTITY_RESOLVER_*=true` (global ON).
- Apply across multiple tenants in one operation.
- Skip the dry-run step for a new tenant.

---

## 3. Monitoring (Grafana panels)

All metrics derived from Loki via `count_over_time` against `[IdentityLink]` log lines. Service label: `service_name="service-flow-backend"`.

| Panel | LogQL |
|---|---|
| Projection success rate | `sum(count_over_time({service_name="service-flow-backend"} \|= "[IdentityLink]" \| event="project" \| outcome="success" [5m])) / sum(count_over_time({service_name="service-flow-backend"} \|= "[IdentityLink]" \| event="project" [5m]))` |
| Projection success / tenant | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "[IdentityLink]" \| event="project" \| outcome="success" [5m]))` |
| Refused (lead_already_linked_to_other) | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "[IdentityLink]" \| outcome="lead_already_linked_to_other" [1h]))` |
| Collisions | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "[IdentityLink]" \| outcome="collision" [1h]))` |
| Cross-tenant blocked | `sum (count_over_time({service_name="service-flow-backend"} \|= "[IdentityLinkInvariantViolation]" [1h]))` |
| Freeze events | `sum (count_over_time({service_name="service-flow-backend"} \|= "[IdentityLink]" \| outcome="freeze" [5m]))` |
| Ambiguity queue growth | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "communication_identity_ambiguities" \|= "insert" [1h]))` (resolver-side) |
| Idempotent rate | `sum (count_over_time({…} \|= "[IdentityLink]" \| outcome="idempotent" [5m]))` |

### Hybrid bridge — metric panels (Phase 0)

Each `[IdentityLink]` line for a hybrid event carries `mode=<mode>` AND `metric=<name>` for filtering. Closed metric set in `cross-source-identity-reconciliation.md` §3a.

| Panel | LogQL |
|---|---|
| Total auto-links per hour (graph + fallback) | `sum(count_over_time({service_name="service-flow-backend"} \|= "metric=identity_graph_projection_success" [1h])) + sum(count_over_time({service_name="service-flow-backend"} \|= "metric=fallback_projection_bridge_success" [1h]))` |
| Graph self-sufficiency ratio (target → 1.0) | `count_over_time({…} \|= "metric=identity_graph_projection_success" [24h]) / ( count_over_time({…} \|= "metric=identity_graph_projection_success" [24h]) + count_over_time({…} \|= "metric=fallback_projection_bridge_success" [24h]) )` |
| Per-tenant fallback dependency (24h) | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=fallback_projection_bridge_success" [24h]))` |
| Fallback ambiguity blocks | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=fallback_projection_bridge_ambiguous" [1h]))` |
| Fallback no-match (excludes opt-in-disabled) | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=fallback_projection_bridge_no_match" \|!= "fallback_disabled" [1h]))` |
| Graph projection skipped — missing lead side | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=graph_projection_skipped_missing_lead" [1h]))` |
| Graph projection skipped — missing customer side | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=graph_projection_skipped_missing_customer" [1h]))` |
| Graph projection skipped — resolver ambiguous | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=graph_projection_skipped_ambiguous" [1h]))` |
| Graph projection skipped — frozen | `sum (count_over_time({service_name="service-flow-backend"} \|= "metric=graph_projection_skipped_frozen" [1h]))` |
| Graph projection skipped — refused (cross-tenant / not-found / linked-other) | `sum by (tenant) (count_over_time({service_name="service-flow-backend"} \|= "metric=graph_projection_skipped_refused" [1h]))` |

### Hydration provenance — Supabase SQL

```sql
-- "How dependent is tenant X on fallback?" — snapshot per tenant.
SELECT user_id,
       COUNT(*) FILTER (WHERE last_hydrated_by = 'graph_projection')           AS graph_count,
       COUNT(*) FILTER (WHERE last_hydrated_by = 'fallback_projection_bridge') AS fallback_count,
       COUNT(*) FILTER (WHERE last_hydrated_by = 'operator_override')          AS operator_count,
       COUNT(*) FILTER (WHERE last_hydrated_by = 'retroactive_repair')         AS repair_count,
       COUNT(*) FILTER (WHERE last_hydrated_by IS NULL)                        AS unhydrated_count
  FROM communication_participant_identities
 GROUP BY user_id
 ORDER BY user_id;

-- Tenants ready for fallback retirement: 14d, zero fallback hydration.
SELECT user_id,
       COUNT(*) FILTER (WHERE last_hydrated_by = 'graph_projection' AND updated_at > now() - interval '14 days') AS graph_14d,
       COUNT(*) FILTER (WHERE last_hydrated_by = 'fallback_projection_bridge' AND updated_at > now() - interval '14 days') AS fallback_14d
  FROM communication_participant_identities
 GROUP BY user_id
HAVING COUNT(*) FILTER (WHERE last_hydrated_by = 'fallback_projection_bridge' AND updated_at > now() - interval '14 days') = 0;
```

**Red lines** (alert thresholds):

| Metric | Page operator if… |
|---|---|
| Cross-tenant blocked > 0 over 10m | Always page. Indicates a bug. |
| `lead_already_linked_to_other` > 1 / day / tenant | Page. Possible double-resolver. |
| Collision > 5 / hour / tenant | Page. Race-condition diagnosis needed. |
| Projection success rate < 95% over 1h | Investigate. May be legitimate refusal (idempotency) — confirm via outcome breakdown. |
| Ambiguity queue growth > 5 / hour / tenant | Investigate. Resolver may be encountering household phones. |
| Graph self-sufficiency ratio drops below baseline | Investigate. Suggests new tenants joined or backfill regressed. |
| `mode=no_match` rises sharply post-deploy | Investigate. Possible regression: graph stopped projecting AND fallback stopped finding HIGH candidates. |
| `mode=fallback_projection_bridge` count > 0 for a tenant in `IDENTITY_SCORING_FALLBACK_TENANTS` opt-out list | Misconfiguration. Tenant was retired prematurely. |

---

## 4. The freeze switch — operational containment

If projection misbehaves during rollout:

```
# Railway:
railway variables --service service-flow-backend-production --set IDENTITY_PROJECTION_FREEZE=true
railway up --service service-flow-backend-production  # force redeploy
```

After redeploy:
- `resolveIdentity` continues running.
- Identity graph (`communication_participant_identities`) continues updating.
- Setters (`setIdentityCustomer`, `setIdentityLead`) continue writing `sf_lead_id` / `sf_customer_id`.
- **Projection to `leads.converted_customer_id` halts.** New auto-links stop.
- `applyLeadCustomerLink` operator override also halted (returns `{ ok: false, error: 'freeze' }`).

This gives containment of CRM-side projection misbehavior without losing identity-graph accumulation.

To unfreeze: set `IDENTITY_PROJECTION_FREEZE` back to `false` or remove the variable.

---

## 5. Rollback procedures

### 5a. Roll back code (revert PR)

```
git revert <phase-0-commit>
git push origin main
# Railway auto-deploys
```

Effect: legacy paths return. Identity table changes already written remain (additive only). `identity_link_audit` table left in place.

### 5b. Roll back tenant flag

```
railway variables --service service-flow-backend-production --remove IDENTITY_RESOLVER_ZENBOOKER_TENANTS
# or set to exclude the tenant: --set IDENTITY_RESOLVER_ZENBOOKER_TENANTS=7   (drop 2)
```

Live ingestion immediately stops calling resolver for that tenant. No new projections.

### 5c. Roll back data (revert N hours of automatic projections)

```sql
BEGIN;

-- 1) Capture what's about to be reverted (for forensic trail).
INSERT INTO identity_link_audit (user_id, lead_id, customer_id, identity_id, resolved_by, resolution_reason, notes)
SELECT user_id, lead_id, customer_id, identity_id, 'operator_rollback', 'rollback_phase_X',
       'reverted at ' || now()::text || ' by operator'
  FROM identity_link_audit
 WHERE user_id = $TENANT
   AND resolved_by IN ('automatic', 'source_projection')
   AND created_at > now() - interval '$N hours';

-- 2) Null out converted_customer_id on the affected leads.
WITH targets AS (
  SELECT DISTINCT lead_id, customer_id
    FROM identity_link_audit
   WHERE user_id = $TENANT
     AND resolved_by IN ('automatic', 'source_projection')
     AND created_at > now() - interval '$N hours'
)
UPDATE leads l
   SET converted_customer_id = NULL,
       converted_at = NULL,
       updated_at = now()
 FROM targets t
 WHERE l.id = t.lead_id
   AND l.user_id = $TENANT
   AND l.converted_customer_id = t.customer_id;

COMMIT;
```

`resolved_by='operator_override'` entries are intentionally **NOT** included — they reflect operator action and must be undone manually if needed.

### 5d. Roll back migration

```bash
# Only if absolutely necessary — destroys audit history.
psql $SUPABASE_URL -f migrations/048_identity_link_audit_down.sql
```

---

## 6. Common operator scenarios

### "I see a duplicate of one customer as a lead too. Should I delete the lead?"

**No.** Never delete the lead.

1. Open Identity Conflicts UI.
2. Find the row by phone.
3. Click "Link lead → customer" — this is the operator-override path (`POST /:id/link-lead`).
4. Lead remains in the system. `converted_customer_id` is set. Funnel analytics preserved.

### "The ambiguity queue exploded after I enabled the flag."

1. Set `IDENTITY_PROJECTION_FREEZE=true` immediately (Section 4).
2. Remove the tenant from `IDENTITY_RESOLVER_*_TENANTS`.
3. Force-redeploy.
4. Inspect the queue: `SELECT reason, count(*) FROM communication_identity_ambiguities WHERE user_id=$T AND status='open' GROUP BY reason ORDER BY count(*) DESC;`
5. If the dominant reason is `phone_name_conflict_or_multi`: tenant has many shared-phone households. Resolver is working correctly. Operator must triage.
6. If dominant is `strict_phone_only_rejected` (during backfill): expected. Operator chooses to enable lenient mode (not yet exposed) or marks as abandoned.

### "I auto-linked a wrong pair. How do I unlink?"

```sql
-- Find the audit row
SELECT * FROM identity_link_audit
 WHERE lead_id = $L AND customer_id = $C AND user_id = $T;

-- If resolved_by = 'automatic' or 'retroactive_repair', safe to revert:
BEGIN;
UPDATE leads SET converted_customer_id = NULL, converted_at = NULL, updated_at = now()
 WHERE id = $L AND user_id = $T AND converted_customer_id = $C;
INSERT INTO identity_link_audit (user_id, lead_id, customer_id, identity_id, resolved_by, resolution_reason, notes)
VALUES ($T, $L, $C, NULL, 'operator_override', 'manual_unlink', 'operator-initiated unlink');
COMMIT;
```

For `resolved_by='operator_override'`, the operator who linked it can use the UI to "unlink" (not yet built — for now do via SQL with extra care, since these were intentional operator decisions).

### "I see a new lead row that looks like a duplicate — should I delete it?"

**Probably not.** After Phase 0.5 the operator may see acquisition events that look like duplicates but are intentional child leads. Check:

```sql
SELECT id, parent_lead_id, source, lead_cost, lead_origin_type, created_at
  FROM leads WHERE id = $L AND user_id = $T;
```

- If `parent_lead_id IS NOT NULL`: this is a child acquisition event. **Keep it.** It preserves the source attribution and cost for the repeat acquisition. The canonical lead's pipeline lifecycle is the source of truth.
- If `lead_origin_type = 'reactivation'`: this is a returning customer who submitted a new LB acquisition. The lead is the acquisition record; the customer relationship lives on `customers`. **Keep it.**
- If `parent_lead_id IS NULL AND lead_origin_type = 'first_touch' OR NULL`: this is a first-touch canonical lead. Removing it loses the original pipeline state. Use Identity Conflicts UI to merge if needed.

### "Person-level conversion rate dropped after Phase 0.5 enablement — is the resolver broken?"

No. After Phase 0.5 the **acquisition-event** denominator increases (children + reactivations are now counted as separate leads). Per-acquisition conversion rate appears to drop even though per-person rate is unchanged.

Switch to the person view:

```bash
curl '.../api/analytics/conversion?viewBy=person' -H 'Authorization: Bearer <jwt>'
```

Returned `personSummary` block has:
- `unique_people` — distinct canonical lead count
- `conversion_rate_per_person` — converted_people / unique_people * 100
- `first_touch_count`, `repeat_acquisition_count`, `reactivation_count` — breakdown

Person-rate is the unchanged metric. Document this in the operator dashboard before tenant rollout.

### "Same phone, two different real people. Identity Conflicts UI says they're combined."

The P0.1 `phone_identity_registry` system flags this. Resolve via:
1. Open the conflict in Identity Conflicts UI.
2. Choose "Keep separate" action — this writes an entry that the SMS recipient integrity guard reads, so future SMS to this phone doesn't get blocked.
3. Optionally edit the customer's phone to differ (e.g., add extension) so future resolution doesn't collide.

---

## 7. Approval gates

| Gate | Approver | Output |
|---|---|---|
| Phase 0 code review | operator | written sign-off in PR |
| Phase 0.5 design review | operator | written sign-off on `lead-cardinality-and-parent-lead-id.md` |
| Phase 0.5 migration | operator | manual `railway run` of migration |
| Phase 1 dry-run results | operator | written sign-off on counts |
| Phase 2 apply | operator | manual curl with `dryRun:false` |
| Phase 3 live enable | operator | manual `railway variables --set` |
| Each subsequent tenant | operator | repeat Phases 1-3 |

No automation walks tenants without explicit operator action per tenant.

---

## 8. Glossary

- **canonical resolver** — `lib/identity-resolver.js`. Only source of matching truth.
- **identity row** — row in `communication_participant_identities`.
- **identity graph** — the collection of identity rows + their external IDs + sf_* pointers.
- **projection** — `projectIdentityToCRM` — writes `leads.converted_customer_id` from identity state.
- **setter** — `setIdentityCustomer` / `setIdentityLead` — only authorized writers of identity sf_* columns.
- **operator override** — `applyLeadCustomerLink` — UI-initiated explicit lead↔customer link.
- **retroactive repair** — `POST /api/identity-conflicts/repair-lead-links` — bulk sweep, dry-run by default.
- **freeze switch** — `IDENTITY_PROJECTION_FREEZE=true`. Stops projection while preserving identity-graph accumulation.
- **canonical lead** — original LB lead. `parent_lead_id IS NULL`. Pointed to by `identity.sf_lead_id`. Owns pipeline lifecycle, tasks, `converted_customer_id`. (Phase 0.5)
- **child lead** — subsequent acquisition record for same identity. `parent_lead_id` set. `lead_origin_type = 'repeat_acquisition'`. Pipeline-invisible. No tasks. No conversion column. (Phase 0.5)
- **reactivation lead** — new canonical lead for an identity that already has `sf_customer_id`. `lead_origin_type = 'reactivation'`. Same identity, new acquisition pipeline. (Phase 0.5)
- **canonical_lead_id** — generated stored column on `leads` = `COALESCE(parent_lead_id, id)`. Indexed. Use for person-level grouping in SQL. (Phase 0.5)
- **first_touch lead** — canonical lead with no prior identity link. `lead_origin_type = 'first_touch'` (or NULL on legacy rows). (Phase 0.5)
- **acquisition attribution** — `lead.source`, `lead.lead_cost`, `lead.created_at`, `lead.lead_origin_type`. **Never overwritten.**
- **acquisition event** — one row in the `leads` table. Each LB submission produces one. Canonical + children = multiple acquisition events per person.
- **person** — identified by `canonical_lead_id` in lead aggregation, by `identity.id` in the identity graph. **The identity row is the singular truth for "who is this real person"; everything else is a projection.**

---

## 9. Incident classes

When an identity-graph incident is reported, classify it FIRST. Class
determines the response, the freeze posture, and the replay decision.

### Class A — Cross-tenant leakage (P1, always-page)

**Definition:** an identity row, lead, or customer for tenant X is
visible to or written by code acting on behalf of tenant Y. Detected via
`[IdentityLinkInvariantViolation]` log lines, or operator-reported.

**Response:**
1. Page identity-v5 owner immediately.
2. Set `IDENTITY_PROJECTION_FREEZE=true` for ALL tenants (not just the
   affected pair) — leakage may not yet be fully scoped.
3. Snapshot `identity_link_audit` for the prior 7d into a forensics table.
4. DO NOT delete affected rows. DO NOT attempt "cleanup" while frozen.
   The forensics matter more than the cleanup.
5. Root-cause before unfreezing. Acceptable triggers for unfreeze: code
   fix deployed + verified on staging + operator written approval.

**What this is NOT:** a tenant seeing the wrong projection within their
own tenant (that's Class C).

### Class B — Wrong merge / wrong split (P1-P2 depending on volume)

**Definition:** two real people merged into one identity, or one real
person split into two identities, when there's no operator-initiated
action behind it.

**Sub-classes:**
- **B1 — Wrong merge** (engine combined two distinct people). P1 if
  affects ≥ 5 identities OR involves payment/billing rows.
- **B2 — Wrong split** (engine created two identity rows for one real
  person). P2 in most cases — auto-link rate suffers but no data corruption.

**Response (B1):**
1. Page identity-v5 owner.
2. Set `IDENTITY_PROJECTION_FREEZE=true` for the affected tenant only.
3. Identify the merge in audit log: `SELECT * FROM identity_link_audit
   WHERE user_id=$T AND resolved_by='automatic' AND created_at > $time
   ORDER BY created_at DESC LIMIT 50`.
4. Manually split via Identity Conflicts UI (do NOT raw-SQL the split —
   the UI writes the audit row + emits the metric).
5. Decide replay (§11) — usually NO, since wrong-merge is operator-recoverable
   and replay re-introduces the bug.

**Response (B2):**
1. Notify identity-v5 owner (no page).
2. Investigate why the resolver produced two rows: usually a phone
   normalisation bug or a name-similarity threshold issue.
3. Once root-caused, operator can manually merge via UI.
4. Replay decision (§11) — usually NO unless the bug affected many tenants.

### Class C — Projection refusal cascade (P2)

**Definition:** the engine returns `kind: 'unknown'` or `decision: 'refused'`
for a large fraction of events. CRM rows stop updating from identity.

**Sub-classes:**
- **C1 — Frozen.** Operator set freeze; this is the expected behaviour.
  Not an incident; verify via `outcome="freeze"` Loki count.
- **C2 — Engine bug.** Resolver started rejecting valid events.
- **C3 — Source side problem.** Webhooks delivering malformed payloads.

**Response:**
1. Check freeze flag status first (1-line Slack check). If `true` and
   intentional → C1, no action.
2. If unintentional or false: pull `metric=graph_projection_skipped_*`
   breakdown in Loki. The dominant skipped-reason tells you C2 vs C3.
3. For C2: revert the most recent engine deploy. Replay decision (§11)
   typically YES — re-process events that were skipped during the bug
   window, since data is recoverable from source webhook logs.
4. For C3: alert source integration owner. Skipped events stay skipped
   until source is fixed; replay decision typically YES after source fix.

### Class D — Operator-induced regression (P2-P3)

**Definition:** an operator made a change (flag flip, manual SQL, UI
action) that introduced wrong identity state. Differs from Class B in
that the cause is known and recent.

**Response:**
1. Identity the change: `git log --since="1 day ago"` for code, Railway
   audit log for env vars, `identity_link_audit` for UI actions.
2. Roll back the operator action (revert PR, restore env var, UI unlink).
3. Replay decision (§11) — typically NO; the regression's blast radius
   is small enough that replay overhead isn't worth it.

### Class E — Transitional-bypass anomaly (P3)

**Definition:** a `[IdentityGraphViolation] kind=transitional_bypass`
warning appears in Loki from a `source=` that's NOT in the transitional
infrastructure registry, OR from a known source at an unexpected volume
(≥ 10× baseline).

**Response:**
1. Identify the source from the log line's `source=` field.
2. If untracked: file as `identity-transitional-untracked` bug. Add to
   registry §1.
3. If known but spiking: investigate caller. Often a new code path
   accidentally exercised an existing transitional helper.
4. No page. No freeze. Investigate during business hours.

### Class summary table

| Class | Trigger | Page? | Freeze posture | Default replay |
|-------|---------|-------|----------------|----------------|
| A     | Cross-tenant leakage | Always | Global freeze | NO |
| B1    | Wrong merge ≥5 affected | Yes  | Per-tenant freeze | NO |
| B2    | Wrong split | No (notify) | None | NO |
| C1    | Intentional freeze | No   | Already frozen | N/A |
| C2    | Engine bug | Yes if widespread | Per-tenant if needed | YES after fix |
| C3    | Source malformed | Notify source | None | YES after source fix |
| D     | Operator regression | No (Slack) | None | NO |
| E     | Untracked transitional | No | None | NO |

---

## 10. Freeze semantics (formal)

The `IDENTITY_PROJECTION_FREEZE` flag is the central operational
containment lever. This section makes its semantics precise.

### 10.1 Scope: per-tenant

The flag is read as `isEnabledForTenant('IDENTITY_PROJECTION_FREEZE',
userId)`. To freeze for a single tenant, set
`IDENTITY_PROJECTION_FREEZE_TENANTS=<csv>`. To freeze globally, set
`IDENTITY_PROJECTION_FREEZE=true`.

Always-on global freeze is a Class A incident response only. For Class
B/C/D, prefer per-tenant freeze.

### 10.2 What freeze STOPS

| Operation | Frozen? |
|-----------|---------|
| `projectIdentityToCRM` (writes `leads.converted_customer_id`) | YES |
| `applyLeadCustomerLink` (operator-override path) | YES — returns `{ok: false, error: 'freeze'}` |
| Engine decisions that include a projection step in their plan | YES — engine returns `decision: 'refused'`, `reason: 'frozen'` |
| Scoring fallback bridge (writes via the linker) | YES — fallback runs but projection step refuses |

### 10.3 What freeze DOES NOT stop

| Operation | Continues during freeze? |
|-----------|--------------------------|
| `resolveIdentity` (writes identity rows only) | YES — graph continues hydrating |
| `setIdentityCustomer` / `setIdentityLead` (direct identity-row writers) | YES |
| Source projection (writes from source events into identity rows) | YES |
| Audit row writes to `identity_link_audit` | YES |
| Webhook receipt and queueing | YES |
| Read endpoints (reporting, lookups) | YES |

**Invariant:** freeze is a write-gate on the CRM-side projection only.
It NEVER blocks identity graph accumulation. This is intentional: data
loss is unrecoverable, but a paused projection is a 30-second flag flip
away from resuming.

### 10.4 Freeze observability

Every freeze-refused operation emits a Loki line with
`outcome="freeze"` AND `metric="graph_projection_skipped_frozen"`. The
counter rate tells you both "is freeze working" and "how much work is
being deferred."

When unfreezing, the operator should expect a brief spike in
`identity_graph_projection_success` as deferred events catch up (these
are NOT new events — they're newly-arriving fresh source events for
which the identity graph already had the data).

### 10.5 Freeze does NOT trigger replay

Unfreeze does not automatically replay events that fired during the
freeze window. If replay is desired (Class C2/C3), explicitly trigger
it via §11. The reason: many freeze windows are precautionary; replay
would re-apply work that was correctly deferred.

### 10.6 Test the freeze switch quarterly

The freeze switch is critical infrastructure that's rarely used. To
prevent bitrot:

1. On staging, set `IDENTITY_PROJECTION_FREEZE=true` for one test tenant.
2. Fire a test webhook for that tenant.
3. Verify Loki shows `outcome="freeze"`.
4. Verify identity row was created/updated but `leads.converted_customer_id`
   stayed NULL.
5. Unfreeze. Verify next event projects normally.
6. Log the test result in `#identity-ops` Slack.

---

## 11. Replay policy

Replay = re-processing source events to re-emit identity decisions after a
code fix or freeze window.

### 11.1 Replay is NEVER automatic

The engine does not auto-replay. Every replay is operator-initiated, scoped
to a tenant + time window, with a written reason.

**Why:** replay can re-apply a bug that was just fixed, or amplify a
regression. The default of NOT replaying is safer than the default of
replaying.

### 11.2 When to replay

| Class | Replay? | Why |
|-------|---------|-----|
| A     | NO  | Cross-tenant leakage — replay would re-leak. Manual cleanup only. |
| B1    | NO  | Wrong merges — replay could re-merge if root cause persists. |
| B2    | NO  | Wrong splits — operator merges via UI on a case basis. |
| C2    | YES (after fix) | Engine bug fixed; events were skipped — replay to catch up. |
| C3    | YES (after source fix) | Source delivered bad data; once fixed, replay. |
| D     | NO  | Operator-induced; specific change is rolled back. |
| E     | NO  | Anomaly is observational; nothing to "replay." |

### 11.3 Replay scope

Replay is always scoped:

- **By tenant:** never global. One tenant per replay job.
- **By time window:** ≤ 24 hours. Larger windows split into multiple jobs.
- **By source:** one integration at a time (LB, ZB, OP, SF).
- **Dry-run first:** every replay starts with `dryRun: true` and the
  operator verifies the count + outcome distribution.

### 11.4 Replay mechanism

Replay reads from the source-side webhook log (LB has `lb_inbound_events`,
ZB has `zb_inbound_events`, OP has `op_message_log`) and re-invokes the
engine for each event.

Idempotency: each event has a stable `external_id` that the engine uses
as an idempotency key. Replaying an event that was already processed
emits `outcome="idempotent"` and writes nothing.

### 11.5 Replay command (template)

```bash
# Dry-run first
curl -X POST '.../api/admin/identity-replay' \
  -H 'Authorization: Bearer <operator JWT>' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": 2,
    "source": "leadbridge",
    "windowStart": "2026-05-22T14:00:00Z",
    "windowEnd":   "2026-05-22T15:00:00Z",
    "dryRun": true,
    "reason": "C2-engine-bug-fix-replay-after-deploy-X"
  }'
```

Expected dry-run response includes per-outcome counts. If counts look
right (mostly `success` and `idempotent`, no surprise `refused`), repeat
with `dryRun: false`.

### 11.6 Replay forbidden during freeze

The replay endpoint refuses if the target tenant is currently frozen. To
replay across a freeze window, unfreeze first, replay, then re-freeze if
needed. (This is intentional — replaying during freeze would emit
`outcome="freeze"` for every event, achieving nothing.)

### 11.7 Replay audit

Each replay writes an `identity_link_audit` entry per affected lead with
`resolved_by='replay'` AND `resolution_reason=<the reason string>`. This
distinguishes replayed links from live and from operator-override links.

### 11.8 Replay budget

A single tenant can have at most **3 replay jobs per day** (rate-limit
enforced server-side). If you find yourself needing more, the underlying
problem is bigger than replay can solve — escalate to a Class B/C
incident review.

### 11.9 Replay endpoint is not yet implemented

As of 2026-05-22, the `POST /api/admin/identity-replay` endpoint is
described but not yet built. The policy is documented here so that when
the endpoint is implemented, the contract is already settled.

**Tracking:** see `docs/architecture/identity-graph-refactor-plan.md`
Phase G+1 — Replay infrastructure.

---

## 12. Cross-references for incident response

When an incident fires, consult in this order:

1. **This runbook** §9 — classify the incident.
2. **`reconciliation-health-dashboard.md`** — confirm metric signal.
3. **`transitional-infrastructure-registry.md`** — identify if a known
   transitional path is implicated.
4. **`fallback-retirement-gates.md`** — if the question is "should we
   retire this code," consult the gate definitions.
5. **`identity-enforcement-roadmap.md`** — if the question is "should
   we promote to stricter enforcement," consult the roadmap stages.
6. **`identity-rollout-governance.md`** — if the question involves a
   tenant tier or stage, consult the maturity definitions.
