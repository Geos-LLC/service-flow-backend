# Stage 2 LB Engine — Rollout Checklist (user_id=2)

**Status:** Pre-flight checklist. **No flag flip without explicit operator approval (step 8).**
**Companion:** [docs/architecture/stage-2-leadbridge-adapter-plan.md](../architecture/stage-2-leadbridge-adapter-plan.md), [docs/architecture/identity-graph-refactor-plan.md](../architecture/identity-graph-refactor-plan.md).
**Authored:** 2026-05-22.

This checklist is the operator-facing runbook for enabling Stage 2 (LB engine adapter) for the first tenant. Each step has an exact command and an explicit pass/fail condition. Items 1–6 must all pass green before step 7 requests approval and step 8 sets the flag.

---

## Baseline snapshot (captured 2026-05-22)

The following observations were captured during checklist preparation and reflect prod state **before** the Stage 2 code is deployed. Re-run each verification at flag-flip time — values may have drifted.

| Check | Observed value | Verdict |
|---|---|---|
| Service Flow project ID | `672437e4-9791-43c4-aa01-5181f3bd1904` | reference |
| Prod environment ID | `31371339-0521-4d17-8ce8-28f5dc7c8423` | reference |
| Backend service ID | `eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7` | reference |
| Latest SUCCESS deploy | `ec12c254-...` commit `c658bff3` (2026-05-21 22:14 UTC) — `feat(identity): auto Lead ↔ Customer reconciliation...` | **Stage 1 + Stage 2 NOT YET DEPLOYED — see step 1** |
| `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` | unset | ✓ engine path will not engage |
| `RECONCILIATION_ENGINE_LEADBRIDGE` (global) | unset | ✓ |
| `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` | unset | n/a — global flag is ON |
| `IDENTITY_RESOLVER_LEADBRIDGE` (global) | `"1"` | ✓ prereq satisfied for all tenants |
| `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` | **unset** | ⚠️ **prereq NOT satisfied for any tenant** |
| `LEAD_CARDINALITY_CHILD_LEADS` (global) | unset | ⚠️ same |
| `IDENTITY_PROJECTION_FREEZE` | unset | ✓ projection enabled (default state) |
| `IDENTITY_RESOLVER_ZENBOOKER` (global) | `"1"` | reference (ZB prereq, not Stage 2) |
| `IDENTITY_RESOLVER_OPENPHONE` (global) | `"1"` | reference (OP prereq, not Stage 2) |
| `ZB_OUTBOUND_GLOBAL_FREEZE` | `"true"` | reference (P0 lockdown — orthogonal) |
| Loki — `[LB engine]` lines (24h) | 0 | ✓ (Stage 2 code not deployed) |
| Loki — `missing_prerequisite` lines (24h) | 0 | ✓ baseline |
| Loki — `[Reconciliation]` lines (24h) | 0 | ✓ (engine not deployed) |
| Loki — `[IdentityLink]` lines (24h) | 0 | reference — quiet window; verify volume post-deploy |
| Loki — `[IdentityLinkInvariantViolation]` (24h) | 0 | ✓ |

**Single most important pre-flight finding:** `LEAD_CARDINALITY_CHILD_LEADS` is OFF in prod (neither global nor per-tenant). The Stage 2 prerequisite chain (`docs/architecture/stage-2-leadbridge-adapter-plan.md` §2) requires it to be ON for the tenant BEFORE the engine flag. If the engine flag is set without first setting the child-leads flag, the adapter will detect the missing prereq, fall back to legacy, and emit one warn per `(tenant, missing-set)` per process — visible but no harm.

The correct flip order for user_id=2 is (1) `LEAD_CARDINALITY_CHILD_LEADS_TENANTS=2` first, (2) deploy/restart not required (env hot-read), (3) `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS=2` second.

---

## 1. Confirm Stage 2 code is deployed to prod

The Stage 2 PR must be merged to `main`, deployed by Railway, and the latest deploy must show `status: SUCCESS`.

```bash
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d.replace(/^\xEF\xBB\xBF/,'')).RAILWAY_TOKEN))")

curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"{ deployments(first: 1, input: { projectId: \"672437e4-9791-43c4-aa01-5181f3bd1904\", environmentId: \"31371339-0521-4d17-8ce8-28f5dc7c8423\", serviceId: \"eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7\" }) { edges { node { id status createdAt meta } } } }"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const n=j.data.deployments.edges[0].node;console.log('status=',n.status);console.log('commit=',n.meta.commitHash);console.log('created=',n.createdAt);console.log('first-line=',(n.meta.commitMessage||'').split('\\n')[0]);});"
```

**Pass conditions (ALL must hold):**

- [ ] `status=SUCCESS`
- [ ] `commit=` matches the merged Stage 2 PR's head commit
- [ ] `first-line=` references Stage 2 / identity-reconciliation-engine adapter
- [ ] Deploy is ≥ 2 minutes old (settled) and < 24 hours old (recent)

If `status=FAILED` or `status=CRASHED`: do NOT proceed. Investigate Railway logs and either fix-forward or revert before continuing.

---

## 2. Confirm engine + prereq flags are in expected pre-flip state

Goal: `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` MUST be unset/empty. The two prereq flags should match the desired pre-flip state for user_id=2 (`LEAD_CARDINALITY_CHILD_LEADS_TENANTS` will be set in step 8a — verify it is currently absent or empty so we know we are starting from a clean state).

```bash
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d.replace(/^\xEF\xBB\xBF/,'')).RAILWAY_TOKEN))")

curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"{ variables(projectId:\"672437e4-9791-43c4-aa01-5181f3bd1904\", environmentId:\"31371339-0521-4d17-8ce8-28f5dc7c8423\", serviceId:\"eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7\") }"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).data.variables;for(const k of ['RECONCILIATION_ENGINE_LEADBRIDGE','RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS','IDENTITY_RESOLVER_LEADBRIDGE','IDENTITY_RESOLVER_LEADBRIDGE_TENANTS','LEAD_CARDINALITY_CHILD_LEADS','LEAD_CARDINALITY_CHILD_LEADS_TENANTS','IDENTITY_PROJECTION_FREEZE']) console.log(k+'='+(k in v?JSON.stringify(v[k]):'<unset>'));});"
```

**Pass conditions:**

- [ ] `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS=<unset>` (or empty string)
- [ ] `RECONCILIATION_ENGINE_LEADBRIDGE=<unset>` (no surprise global flip)
- [ ] `IDENTITY_RESOLVER_LEADBRIDGE="1"` OR `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` contains `2`
- [ ] `LEAD_CARDINALITY_CHILD_LEADS_TENANTS=<unset>` AND `LEAD_CARDINALITY_CHILD_LEADS=<unset>` (we will set the per-tenant value in step 8a — start clean)
- [ ] `IDENTITY_PROJECTION_FREEZE=<unset>` or `"false"` (default OFF) **unless** the operator intentionally has it on for an unrelated incident

If `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` is non-empty: someone else has flipped it. Stop and investigate before proceeding.

---

## 3. Confirm baseline Loki — no prerequisite-miss warns

After Stage 2 is deployed but before flag flip, prereq-miss warns should be zero. A non-zero count means the engine flag is already set somewhere unexpected (likely a stale variable).

```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d.replace(/^\xEF\xBB\xBF/,'')).GRAFANA_SA_TOKEN))")

# Wake Grafana if cold
curl -s "https://info3d7b.grafana.net/api/org" -H "Authorization: Bearer $TOKEN" > /dev/null

curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "missing_prerequisite" [1h])' \
  --data-urlencode "start=$(date -d '1 hour ago' +%s)000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode 'step=3600'
```

**Pass condition:**

- [ ] `result: []` (no streams) — zero prereq-miss warns in the last hour.

If non-zero: read the actual log lines (drop the `count_over_time(...)` wrapper, fetch `--data-urlencode 'query={service_name="service-flow-backend"} |= "missing_prerequisite"'`) and resolve before proceeding.

---

## 4. Confirm Identity Projection freeze is OFF

The freeze switch is the global brake on CRM-business-link projection. If it's on, the engine path will return `decision=frozen` for every writing event — no leads/customers will get projected, and the rollout is a no-op (worse, it would mask whether the engine works).

Already covered by the env-var read in step 2. Repeated here as an explicit gate:

**Pass condition:**

- [ ] `IDENTITY_PROJECTION_FREEZE` is unset OR `"false"` OR `"0"`.

If the operator has intentionally set freeze for an unrelated reason: postpone Stage 2 rollout until freeze is cleared.

---

## 5. Prepare rollback commands (DO NOT RUN — keep in clipboard)

Three rollback levers, in increasing scope. Keep these in a terminal tab so they can be run within seconds if monitoring shows trouble.

### 5a. Disable engine for tenant (or all tenants) — preferred fast rollback

Remove `2` from `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS`, or clear it entirely:

```bash
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d.replace(/^\xEF\xBB\xBF/,'')).RAILWAY_TOKEN))")

# Clear entirely (safest — disables engine for ALL tenants)
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableDelete(input: { projectId: \"672437e4-9791-43c4-aa01-5181f3bd1904\", environmentId: \"31371339-0521-4d17-8ce8-28f5dc7c8423\", serviceId: \"eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7\", name: \"RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS\" }) }"}'
```

Effect: next event for user_id=2 routes through legacy path. No restart required — Node re-reads `process.env` per call (verified by rollout test #13).

### 5b. Halt projection globally (engine continues, CRM business link freezes)

If the engine itself looks fine but `[IdentityLink]` `outcome=success` is collapsing:

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableUpsert(input: { projectId: \"672437e4-9791-43c4-aa01-5181f3bd1904\", environmentId: \"31371339-0521-4d17-8ce8-28f5dc7c8423\", serviceId: \"eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7\", name: \"IDENTITY_PROJECTION_FREEZE\", value: \"true\" }) }"}'
```

Effect: identity row updates continue (resolver runs); projection to `leads.converted_customer_id` halts. Already covered by all existing identity-linker tests.

### 5c. Catastrophic — revert the Stage 2 PR

Zero schema changes were introduced. Revert the merge commit, re-deploy:

```bash
# On a local checkout of main:
git revert <stage-2-merge-commit-sha> --no-edit
git push origin main
# Railway auto-deploys
```

Reversal time: ~3 minutes (build + deploy). After revert, all tenants are on the pre-Stage-2 legacy code.

---

## 6. Prepare Loki monitoring queries

Bookmark these in Grafana or keep handy in a terminal. **Run after the flag flip** at T+5min, T+1h, T+6h, T+24h, T+48h to gate the §11 acceptance criteria.

Auth setup (all queries use the same token):

```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d.replace(/^\xEF\xBB\xBF/,'')).GRAFANA_SA_TOKEN))")
LOKI="https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range"
SINCE=$(date -d '1 hour ago' +%s)000000000
NOW=$(date +%s)000000000
```

### 6a. Engine activation — must rise above zero after T+5min

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[Reconciliation]" |= "source=leadbridge" |= "tenant=2" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** non-zero within 1h of flag flip (assuming LB webhook traffic for tenant 2 in that window). Zero after 1h with known LB traffic = engine path not engaging — investigate.

### 6b. `[LB engine] path=engine` — same expectation, adapter-side

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[LB engine]" |= "path=engine" |= "tenant=2" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** counts roughly match 6a (one `[LB engine]` per `[Reconciliation]` for tenant 2). Divergence indicates a code-path drift.

### 6c. `[LB engine] path=legacy` — should remain zero for tenant 2

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[LB engine]" |= "path=legacy" |= "tenant=2" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** zero. Non-zero = prerequisite chain breaking → tenant fell back to legacy with warn.

### 6d. `missing_prerequisite` warns — should be zero post-flip

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "missing_prerequisite" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** zero. Any non-zero value is an immediate alarm — read the line to see which prereq is missing for which tenant. Most likely cause: `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` not set when `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` was set.

### 6e. Ambiguity queue growth — must stay ≤ 5/hr per `cross-source-identity-reconciliation.md` §12

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "communication_identity_ambiguities" |= "insert" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** ≤ 5 per rolling hour. Sudden jump > 10/hr suggests the resolver is now seeing collisions it didn't see before (could indicate the engine is now being called on events the legacy path skipped — investigate the actual ambiguity rows).

### 6f. `[IdentityLink] outcome=success` — projection success rate

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" |= "outcome=success" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** rate ≥ legacy 7-day baseline (capture baseline below before flip). The engine should not cause projection regressions.

To capture pre-flip baseline (run BEFORE flag flip):

```bash
SINCE7D=$(date -d '7 days ago' +%s)000000000
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" |= "outcome=success" [7d])' \
  --data-urlencode "start=$SINCE7D" --data-urlencode "end=$NOW" --data-urlencode 'step=86400'
# Record the daily counts — they're the post-flip floor.
```

### 6g. `[IdentityLinkInvariantViolation]` — must remain zero

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[IdentityLinkInvariantViolation]" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** zero. Any non-zero value = cross-tenant attempt (R3 / I1 breach) — IMMEDIATE rollback via 5a or 5b, then triage.

### 6h. (optional) `[LB engine] grandchild_refusal` — should be zero or very rare

```bash
curl -s -G "$LOKI" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=count_over_time({service_name="service-flow-backend"} |= "[LB engine]" |= "grandchild_refusal" [1h])' \
  --data-urlencode "start=$SINCE" --data-urlencode "end=$NOW" --data-urlencode 'step=300'
```

**Expected:** zero. Non-zero indicates an identity is pointing at a child lead (corruption in the existing data) — note the parent id and flag for follow-up. The engine handles this safely (falls through to enrich on the canonical), so it's not an emergency.

---

## 7. Request explicit operator approval

**At this point: items 1–6 must all be green.** Do not advance to step 8 without the operator's explicit "go" message.

Suggested approval-request message to send to the operator:

> Stage 2 LB engine pre-flight complete for user_id=2.
>
> - Deploy: ✓ commit `<sha>` SUCCESS at `<UTC time>`
> - Flags: ✓ engine flag empty, freeze OFF, prereq state captured
> - Loki baseline: ✓ zero `[LB engine]`, zero `missing_prerequisite`, zero `[IdentityLinkInvariantViolation]`
> - Rollback commands prepared (5a/5b/5c)
> - Monitoring queries bookmarked (6a–6h)
> - `[IdentityLink] outcome=success` 7-day baseline: `<n/day>` (this is the post-flip floor)
>
> Requesting approval to (a) set `LEAD_CARDINALITY_CHILD_LEADS_TENANTS=2`, then (b) set `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS=2`. No restart required.
>
> Reply "Go" to proceed.

If reply is anything other than an explicit go: STOP. Do not flip flags.

---

## 8. Flip flags (ONLY after explicit approval)

Order matters: child-leads first, engine second. The plan §2 explains why.

### 8a. Set the child-leads prerequisite

```bash
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d.replace(/^\xEF\xBB\xBF/,'')).RAILWAY_TOKEN))")

curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableUpsert(input: { projectId: \"672437e4-9791-43c4-aa01-5181f3bd1904\", environmentId: \"31371339-0521-4d17-8ce8-28f5dc7c8423\", serviceId: \"eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7\", name: \"LEAD_CARDINALITY_CHILD_LEADS_TENANTS\", value: \"2\" }) }"}'
```

Wait ~30s. Now repeat run for 6d (`missing_prerequisite` query) and confirm still zero. Wait through one webhook event for tenant 2 (or trigger a sync) — `[LB engine]` should still be zero (engine flag itself isn't yet set), but the prereq state is now satisfied.

### 8b. Set the engine flag

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableUpsert(input: { projectId: \"672437e4-9791-43c4-aa01-5181f3bd1904\", environmentId: \"31371339-0521-4d17-8ce8-28f5dc7c8423\", serviceId: \"eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7\", name: \"RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS\", value: \"2\" }) }"}'
```

Wait through one LB webhook event for tenant 2 (or operator-triggered sync). Run query 6a — should now be non-zero. Run 6b — should match. Run 6c — should be zero.

### 8c. T+5 minute soak — first observation point

Run queries 6a, 6b, 6c, 6d, 6g. Pass = 6a + 6b non-zero, 6c + 6d + 6g all zero. Fail of any = rollback via 5a.

### 8d. T+1 hour, T+6 hour, T+24 hour, T+48 hour observation points

Re-run the full 6a–6h panel at each interval. Pass criteria per `docs/architecture/stage-2-leadbridge-adapter-plan.md` §11:

- 6a (`[Reconciliation] source=leadbridge tenant=2`): non-zero.
- 6c (`[LB engine] path=legacy tenant=2`): zero after first cache warm.
- 6d (`missing_prerequisite`): zero.
- 6e (ambiguity queue growth): ≤ 5/hr.
- 6f (`[IdentityLink] outcome=success` rate): ≥ pre-flip baseline.
- 6g (`[IdentityLinkInvariantViolation]`): zero.

48 hours of green → Stage 2 → Stage 3 gate open (per the refactor plan).

---

## 9. Sign-off

Record the rollout outcome here. Update after each observation point.

| Time | Step | Outcome | Notes |
|---|---|---|---|
| T-30min | Items 1–6 pre-flight | __ pass __ fail | |
| T0 | Step 7 approval received from operator | __ yes __ no | |
| T0+30s | Step 8a (child-leads flag set) | __ pass __ fail | |
| T0+60s | Step 8b (engine flag set) | __ pass __ fail | |
| T+5min | Step 8c soak | __ pass __ fail | |
| T+1h | 6a–6h panel | __ pass __ fail | |
| T+6h | 6a–6h panel | __ pass __ fail | |
| T+24h | 6a–6h panel | __ pass __ fail | |
| T+48h | 6a–6h panel + operator dashboard sign-off | __ pass __ fail | gate open for Stage 3 |

If any observation point fails: trigger the corresponding rollback (5a / 5b / 5c) and record the rollback time + reason.

---

## 10. Pointers

- Stage 2 plan: [docs/architecture/stage-2-leadbridge-adapter-plan.md](../architecture/stage-2-leadbridge-adapter-plan.md).
- Refactor plan: [docs/architecture/identity-graph-refactor-plan.md](../architecture/identity-graph-refactor-plan.md).
- Engine design: [docs/architecture/identity-reconciliation-engine-design.md](../architecture/identity-reconciliation-engine-design.md).
- Existing identity runbook: [identity-reconciliation-runbook.md](./identity-reconciliation-runbook.md).
- Project tokens + Loki credentials: `aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1`.
- Service Flow Railway project: `672437e4-9791-43c4-aa01-5181f3bd1904` (env `31371339-0521-4d17-8ce8-28f5dc7c8423` = prod).
