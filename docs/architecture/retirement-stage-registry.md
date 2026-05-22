# Retirement Stage Registry

**Status:** Canonical, single source of truth for transitional-code stage tags
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-governance-principles.md](identity-governance-principles.md) — why these stages exist
- [identity-enforcement-roadmap.md](identity-enforcement-roadmap.md) — code-level enforcement progression
- [transitional-infrastructure-registry.md](transitional-infrastructure-registry.md) — every bypass that carries one of these tags
- [fallback-retirement-gates.md](fallback-retirement-gates.md) — numeric thresholds per stage transition

---

## 1. Why this document exists

Every `@retirement-stage:` value in the codebase is one of a fixed, closed
set defined here. Without this registry, the tag drifts into freeform
strings (`@retirement-stage: soon`, `@retirement-stage: someday`, etc.) and
loses signal. CI scanner consults this list as the canonical vocabulary;
ops, audit, and refactor decisions cite the stage names verbatim.

> **Rule:** A bypass site MUST tag itself with one stage from this registry.
> Inventing a new stage requires a PR against this document — same approval
> path as the bypass itself.

---

## 2. The five stages

| Stage tag | Name | Plain meaning | What enforcement does | What ops sees |
|-----------|------|---------------|----------------------|---------------|
| `stage-1-observe` | Observe-only | Bypass exists. We watch it but do not pressure removal yet. | Warn-only emit at runtime + warn-only scanner finding. | Loki counts the warn; no operator action expected. |
| `stage-2-ci-static` | CI / static check | Bypass exists. CI fails on undocumented sites. | Direct-write detection gates `--strict`; metadata warnings still advisory. | Operator sees scanner errors in PR if a new bypass is added without instrumentation. |
| `stage-3-runtime-block` | Runtime block (allow-list) | Bypass exists only for the explicit allow-list of tenants/sites. Everything else 4xx/5xx. | Runtime middleware refuses non-allow-list writes; warn-only sites pass through. | Operator sees a refused-write metric spike when an integration drifts; same site fails for new tenants. |
| `stage-4-adapter-only` | Adapter-only | All identity writes for this surface must go through the adapter pattern. Direct writes are gone from app code. | Scanner has zero hits for this surface. Adapter is the only authorized writer. | Operator sees the writer source on `last_hydrated_by`; no direct writes appear. |
| `stage-5-remove` | Removal | The bypass is being deleted. The `recordTransitionalBypass` call goes away in the same PR as the registry retirement. | Scanner no longer matches this site at all. | Operator confirms the metric drops to zero, then this row moves to the Retired section of the registry. |

---

## 3. Stage transitions

Stages advance left → right. Each transition has a numeric gate (see
`fallback-retirement-gates.md`) that MUST clear before the tag is bumped.

```
stage-1-observe  →  stage-2-ci-static  →  stage-3-runtime-block  →  stage-4-adapter-only  →  stage-5-remove
        ▲                  ▲                        ▲                          ▲                       ▲
        │                  │                        │                          │                       │
   bypass added       PR adds the              metric soak +              adapter shipped         operator removes
   (warn-only)        site to allow-list       tenant coverage            + zero direct writes    the call + the row
   default for        in the scanner
   any new            (per-roadmap)
   site
```

Demotion (right → left) is also a valid move. If a stage-3 bypass starts
firing for unexpected tenants, the operator drops it back to stage-2 (CI
remains, but runtime blocking is removed). Demotion is announced in
`#identity-ops` and never silent.

---

## 4. Current stage mapping (snapshot 2026-05-22)

Every `recordTransitionalBypass` call site in the codebase, with the stage
each carries today.

| # | File / function | Stage |
|---|----------------|-------|
| 1 | `server.js:maybeCreateLeadFromOpenPhone` — `crm_phone_anchor_customer` | `stage-4-adapter-only` |
| 2 | `server.js:maybeCreateLeadFromOpenPhone` — `crm_phone_anchor_lead` | `stage-4-adapter-only` |
| 3 | `server.js:maybeCreateLeadFromOpenPhone` — post-lead-create attach | `stage-4-adapter-only` |
| 4 | `server.js:convert_lead_to_customer_endpoint` | `stage-2-ci-static` |
| 5 | `server.js:merge_duplicate_customers` | `stage-3-runtime-block` |
| 6 | `lib/identity-backfill.js:backfillZenbookerCustomers` | `stage-3-runtime-block` |
| 7 | `lib/identity-backfill.js:runIdentityBackfill` | `stage-3-runtime-block` |

These tags are visible in the source at each call site (the
`@retirement-stage:` line inside the structured metadata block) and are
emitted by the scanner when verifying metadata completeness.

---

## 5. Tag invariants

- **Closed set.** Any value outside §2's `Stage tag` column is a CI
  warning. Operators see it as a scanner finding the next time the
  warn-only gate runs.
- **One tag per call.** A bypass cannot straddle stages.
- **Tag in source, not external doc.** The authoritative value is the
  one in the `recordTransitionalBypass` adjacent metadata block. Docs
  paraphrase; source is source.
- **Tag is observable.** When the bypass fires, the runtime emitter
  includes `kind=transitional_bypass` and the `source=` field. The
  retirement stage isn't emitted as a structured field today; operators
  cross-reference source → stage via this registry.

---

## 6. Adding a new stage

If a new stage is genuinely needed (e.g., a sixth stage between
adapter-only and removal), do this in one PR:

1. Add the row to §2 of this document with name + plain meaning +
   enforcement description.
2. Update the scanner's accepted set if applicable (the scanner does
   not currently parse stage names — it only checks the `@retirement-stage`
   tag is present — so this step is usually a no-op).
3. Update `identity-enforcement-roadmap.md` if the stage maps to a code-
   level enforcement transition.
4. Get identity-v5 owner sign-off.

Do not add a stage without justification. Five stages is enough for the
foreseeable refactor; adding more dilutes the signal.

---

## 7. Removing a stage

If a stage stops being used (e.g., every bypass at stage-2 has moved on),
do NOT remove the row. Mark it `Status: Reserved` and keep it for future
use. The shape of the lifecycle stays five-staged even if some stages are
empty at a point in time.

---

## 8. Cross-references at a glance

| Question | Where to look |
|----------|---------------|
| What does `stage-N-x` mean? | §2 here |
| What stage is bypass Y at today? | §4 here, or read the source's metadata block |
| When does a stage advance? | `fallback-retirement-gates.md` (per-system gates) |
| What enforcement does each stage produce in code? | `identity-enforcement-roadmap.md` |
| Where is bypass Y described in detail? | `transitional-infrastructure-registry.md` |
