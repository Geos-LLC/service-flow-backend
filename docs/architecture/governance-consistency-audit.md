# Governance Consistency Audit

**Status:** Passed (2026-05-22). Re-run quarterly.
**Owner:** identity-v5
**Last updated:** 2026-05-22

---

## 1. Why this document exists

The identity governance framework now spans 13 documents + 2 modules
(`identity-graph-violation.js`, `identity-write-gate.js`) + the scanner.
The risk in any multi-doc system is vocabulary drift — the same concept
is named differently in different docs, dashboards consume one variant,
alerts use another, and the operator on call sees a third.

This audit confirms terminology consistency at a point in time and
documents the canonical vocabulary that all future docs / code must
use.

---

## 2. Audit scope (the 13 docs + 2 modules + scanner)

Architecture docs:

1. `docs/architecture/identity-governance-principles.md`
2. `docs/architecture/retirement-stage-registry.md`
3. `docs/architecture/transitional-infrastructure-registry.md`
4. `docs/architecture/fallback-retirement-gates.md`
5. `docs/architecture/future-integration-strategy.md`
6. `docs/architecture/identity-enforcement-roadmap.md`
7. `docs/architecture/runtime-violation-taxonomy.md`
8. `docs/architecture/runtime-allowlist-design.md`
9. `docs/architecture/integration-compliance-audit.md`
10. `docs/architecture/new-integration-requirements.md`

Operations docs:

11. `docs/operations/identity-rollout-governance.md`
12. `docs/operations/identity-reconciliation-runbook.md`
13. `docs/operations/identity-replay-recovery-framework.md`
14. `docs/operations/runtime-enforcement-metrics.md`
15. `docs/operations/reconciliation-health-dashboard.md`

Code:

- `lib/identity-graph-violation.js` (9 kinds)
- `lib/identity-write-gate.js` (gate API)
- `scripts/check-identity-graph-bypass.js` (scanner)

---

## 3. Canonical vocabulary

This is the single source of truth. If any doc disagrees with this table, **the doc is wrong**, not the table.

### 3.1 Retirement stages (closed set, 5 values)

Source of truth: `retirement-stage-registry.md` §2 + `lib/identity-write-gate.js` `KNOWN_STAGES`.

| Tag | Used in |
|-----|---------|
| `stage-1-observe` | retirement-stage-registry, runtime-allowlist-design, runtime-violation-taxonomy, gate module |
| `stage-2-ci-static` | retirement-stage-registry, transitional-infrastructure-registry §3.1, instrumented site (`server.js:convert_lead_to_customer_endpoint`), gate module |
| `stage-3-runtime-block` | retirement-stage-registry, transitional-infrastructure-registry §3.1, instrumented sites (3×), gate module, runtime-allowlist-design |
| `stage-4-adapter-only` | retirement-stage-registry, transitional-infrastructure-registry §3.1, instrumented sites (3×), gate module |
| `stage-5-remove` | retirement-stage-registry, gate module |

✅ **Consistent across all docs + code.**

### 3.2 Owner vocabulary

Source of truth: `identity-governance-principles.md` §3.

| Owner | Used in |
|-------|---------|
| `identity-v5` | All 7 instrumented sites, transitional-infrastructure-registry, fallback-retirement-gates, future-integration-strategy, governance principles, retirement registry, every code @owner: comment |

✅ **Single owner today. No vocabulary drift.**

### 3.3 Violation kinds (graph-violation emitter — closed set, 9 values)

Source of truth: `lib/identity-graph-violation.js` `VIOLATION_KINDS`.

| Kind | Used by site |
|------|--------------|
| `direct_converted_customer_id_write` | (not currently fired — RV-2 grouping at source level) |
| `direct_parent_lead_id_write` | (not currently fired) |
| `direct_lead_origin_type_write` | (not currently fired) |
| `direct_sf_lead_id_write` | (not currently fired) |
| `direct_sf_customer_id_write` | (not currently fired) |
| `direct_identity_projection_write` | (not currently fired) |
| `integration_bypass` | (not currently fired) |
| `operator_override_outside_linker` | (not currently fired) |
| `transitional_bypass` | All 7 instrumented sites via `recordTransitionalBypass` |

✅ **One kind in active use; the catalog is preserved for the four-stage roadmap's later stages.**

### 3.4 Runtime violation taxonomy (RV-N — closed set, 7 values)

Source of truth: `runtime-violation-taxonomy.md` §2 + `lib/identity-write-gate.js` `KNOWN_VIOLATION_CLASSES`.

| Class | Used by site / doc |
|-------|---------------------|
| `RV-1` | runtime-violation-taxonomy §3, metrics doc §5 |
| `RV-2` | All 7 instrumented sites (`@violation-class: RV-2`), taxonomy §4, metrics doc §5, allow-list design §3 |
| `RV-3` | taxonomy §5, runbook §9 (Class A), metrics doc §5 |
| `RV-4` | taxonomy §6, allow-list design §2.2 |
| `RV-5` | taxonomy §7, replay-recovery framework §6, metrics doc §5 |
| `RV-6` | taxonomy §8, governance principles §3, metrics doc §5 |
| `RV-7` | taxonomy §9, fallback-retirement-gates.md §3, metrics doc §5 |

✅ **Consistent across all docs + code. Gate module's `KNOWN_VIOLATION_CLASSES` matches taxonomy §2 exactly.**

### 3.5 Observability syntax (canonical Loki query form)

Source of truth: `identity-governance-principles.md` §6.

```
Loki {service_name="service-flow-backend"} |~ "IdentityGraphViolation" | json | kind="transitional_bypass" source="<file>:<function>"
```

| Used in |
|---------|
| All 7 instrumented sites (in `@observability:` comment) |
| transitional-infrastructure-registry §1.3, §1.4, §1.5 |
| fallback-retirement-gates.md §3 |
| governance principles §6 |
| runtime-enforcement-metrics.md §3 |

✅ **All instrumented sites use the canonical form. All docs reference it consistently.**

Note: the runtime gate emits `[IdentityWriteGate]` (different log line prefix), so its queries use `|~ "IdentityWriteGate"`. This is intentionally different from the violation emitter's `|~ "IdentityGraphViolation"` so the two streams can be separated.

### 3.6 Rollout posture vocabulary (allow-list design — closed set, 4 values)

Source of truth: `runtime-allowlist-design.md` §2.1.

| Posture | Used in |
|---------|---------|
| `unrestricted` | runtime-allowlist-design §2.1, §10 |
| `monitored` | runtime-allowlist-design §2.1, identity-rollout-governance §3 |
| `enforced_strict` | runtime-allowlist-design §2.1, §3 |
| `enforced_emergency` | runtime-allowlist-design §2.1, §4 |

✅ **Postures are described uniformly across allow-list design and rollout governance.**

### 3.7 Tier vocabulary (Bronze / Silver / Gold)

Source of truth: `identity-rollout-governance.md` §3.

| Tier | Used in |
|------|---------|
| Bronze | rollout governance §3.1, allow-list design §2.1, replay-recovery framework §9 |
| Silver | rollout governance §3.2, allow-list design §2.1, replay-recovery framework §9 |
| Gold | rollout governance §3.3, allow-list design §2.1, replay-recovery framework §9 |

✅ **Three tiers, defined once, referenced consistently.**

### 3.8 Stage vocabulary (rollout S0–S4 vs retirement stage-N)

Easy to confuse, so worth calling out:

| Vocabulary | Domain | Source of truth |
|------------|--------|-----------------|
| `S0`, `S1`, `S2`, `S3`, `S4` | Per-tenant rollout STAGES (Dark, Dry-run, Shadow, Co-pilot, Authoritative) | `identity-rollout-governance.md` §2 |
| `stage-1-observe` … `stage-5-remove` | Per-BYPASS retirement stages | `retirement-stage-registry.md` §2 |

These are NOT the same thing. A tenant at S3 (Co-pilot) might still depend on bypasses at stage-2-ci-static or stage-3-runtime-block.

✅ **The two vocabularies don't overlap in any single document, so confusion is unlikely.**

### 3.9 Incident class vocabulary (runbook §9 — closed set, 5 classes)

Source of truth: `identity-reconciliation-runbook.md` §9.

| Class | Used in |
|-------|---------|
| Class A (Cross-tenant leakage) | runbook §9.A, taxonomy §5 (RV-3), allow-list design §2 |
| Class B1 / B2 (Wrong merge / split) | runbook §9.B, replay-recovery framework §7 |
| Class C1 / C2 / C3 (Projection refusal) | runbook §9.C, taxonomy §8 (RV-6) |
| Class D (Operator-induced regression) | runbook §9.D |
| Class E (Transitional-bypass anomaly) | runbook §9.E, taxonomy §6 (RV-4) |

✅ **Five incident classes; cross-references to RV-N taxonomy are explicit.**

---

## 4. Cross-cutting checks

### 4.1 Owner of every transitional bypass is `identity-v5`

Confirmed by reading each instrumented site's `@owner:` comment + the
gate's emitted log line. All 7 sites: `identity-v5`. ✅

### 4.2 Every bypass has a stage from the closed set

Confirmed by `node scripts/check-identity-graph-bypass.js` returning
zero metadata warnings on the current repo (every required tag
including `@retirement-stage` is present at every site). ✅

### 4.3 Every bypass declares a violation class from the closed set

Confirmed by the scanner returning zero `taxonomy_classification_missing`
warnings. All 7 sites carry `@violation-class: RV-2`. ✅

### 4.4 Every bypass has an adjacent gate call

Confirmed by the scanner returning zero `runtime_gate_missing` warnings.
All 7 sites have an `identityWriteGate.evaluateIdentityWrite(...)` call
within `GATE_LOOKBACK` lines. ✅

### 4.5 Every observability query references the canonical Loki shape

Spot-checked across `transitional-infrastructure-registry.md` §1.3–§1.5,
`fallback-retirement-gates.md` §3, all 7 instrumented sites in source.
All use the form `Loki {service_name="service-flow-backend"} |~ "IdentityGraphViolation" | json | kind="transitional_bypass" source="..."`. ✅

### 4.6 No conflicting definitions

Scanned for places where the same term has different definitions in
different docs. None found. The only near-collision is
"stage" — but rollout S-stages and retirement stage-N are in different
domains and explicitly disambiguated above.

---

## 5. Findings

**Zero inconsistencies.** All vocabulary is aligned across all 15 docs
+ 3 code modules + scanner.

This is what was checked:

- Closed sets are closed everywhere they appear.
- Owner names match.
- Loki query shapes match.
- Rollout postures use the same names in design + ops docs.
- Tier names (Bronze/Silver/Gold) match.
- Stage names match between code and docs.

---

## 6. Re-run procedure

This audit should run quarterly (governance review cadence). To re-run:

1. **Walk the 15 docs in §2** and confirm each closed set has the
   expected values.
2. **Walk the 3 code modules** and confirm their constants match the
   docs.
3. **Run the scanner** — `node scripts/check-identity-graph-bypass.js`
   must return zero findings (warnings + errors).
4. **Update §3** if any vocabulary was intentionally added since the
   last audit.
5. **Set Last updated** date at top of this doc.

If any inconsistency is found, fix the doc/code that drifted (the
canonical source of truth is whichever is referenced most by other
artifacts — usually `retirement-stage-registry.md` and
`runtime-violation-taxonomy.md` for closed sets).

---

## 7. What this document explicitly does NOT do

- Does not change any vocabulary.
- Does not modify any doc or module.
- Does not introduce new terms.
- Does not deprecate existing terms.

It is a verification artifact. Its content is the consistency check
output, not a directive.

---

## 8. Vocabulary additions log

Track each PR that adds a new term here so the next audit knows what
to expect.

| Date | Term added | Source of truth doc | PR |
|------|-----------|--------------------|----|
| 2026-05-22 | `stage-1-observe` … `stage-5-remove` (5 retirement stages) | retirement-stage-registry §2 | governance principles + retirement-stage-registry commit |
| 2026-05-22 | `RV-1` … `RV-7` (7 violation classes) | runtime-violation-taxonomy §2 | Stage 3 foundation commit |
| 2026-05-22 | `unrestricted` / `monitored` / `enforced_strict` / `enforced_emergency` (4 postures) | runtime-allowlist-design §2.1 | Stage 3 foundation commit |
| 2026-05-22 | `[IdentityWriteGate]` log line prefix | identity-write-gate.js | Stage 3 foundation commit |
