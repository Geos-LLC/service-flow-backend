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

**Red lines** (alert thresholds):

| Metric | Page operator if… |
|---|---|
| Cross-tenant blocked > 0 over 10m | Always page. Indicates a bug. |
| `lead_already_linked_to_other` > 1 / day / tenant | Page. Possible double-resolver. |
| Collision > 5 / hour / tenant | Page. Race-condition diagnosis needed. |
| Projection success rate < 95% over 1h | Investigate. May be legitimate refusal (idempotency) — confirm via outcome breakdown. |
| Ambiguity queue growth > 5 / hour / tenant | Investigate. Resolver may be encountering household phones. |

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
