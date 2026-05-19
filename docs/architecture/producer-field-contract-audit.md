# Producer Field Contract Audit — `job.create` (Phase B re-arm gate)

**Date:** 2026-05-19
**Status:** Pre-unfreeze artifact. Production is `ZB_OUTBOUND_GLOBAL_FREEZE=true`. This document is a precondition for re-arming.
**Trigger:** First live POST (command `eb778119-cb11-486c-a958-2673198ace29`, SF job 142206, 2026-05-19) rejected by ZB with `400 INVALID_TIME_SLOT — timeslot.start is required`. Root cause: producer emitted `timeslot.start_time`; ZB requires `timeslot.start`. See [diagnosis in zb-outbound-runbook §3.2 incident log] and the in-flight design v0.6 §R1.
**Goal:** Audit every field the producer emits in the `job.create` body. For each, classify the evidence we hold for (a) field name, (b) value format, (c) live acceptance. Surface every remaining inference *before* the next live POST so we are not surprised twice.

---

## 0. Methodology

### 0.1 Evidence taxonomy

| Tier | Label | What it means |
|---|---|---|
| **A** | **Live evidence — positive** | We have a 2xx from `POST /v1/jobs` confirming this field name + value shape was accepted. |
| **B** | **Live evidence — negative** | We have a 4xx response from `POST /v1/jobs` that specifically mentions this field, telling us its correct name/shape. |
| **C** | **Roundtrip evidence** | We received the field/value from ZB (via GET response, webhook, or inbound sync) and are re-sending it. The value is ZB-minted; ZB should accept its own ids. Does NOT verify that the field NAME we use to send it is correct. |
| **D** | **Documentation** | The public ZB docs at `developers.zenbooker.com/reference/create-a-job` list this field with this name and type. |
| **E** | **Inference (untested)** | We chose the name/shape based on adjacent evidence (response shape, sibling endpoints, REST conventions). No direct verification. |
| **F** | **Inference (refuted)** | We previously inferred a name/shape; live evidence has since refuted it. |

Confidence is the lowest tier that applies. A field can be `D` for the name and `E` for an internal sub-key.

### 0.2 What the audit cannot cover

Tier A evidence requires a successful POST. We do not have one. Every field that depends on Tier A alone for confidence remains UNVERIFIED until either (a) a controlled live POST succeeds, or (b) ZB support confirms in writing. Tier C is *not* a substitute for Tier A: ZB minting an id doesn't prove our outbound field name carrying that id is correct (today's bug is the perfect example — `timeslot.start_time` carried a perfectly valid ISO timestamp ZB had emitted on a prior webhook, but the field key was wrong).

### 0.3 Sources consulted

| Source | Reference |
|---|---|
| Public ZB docs | [zb-api-verification.md §3.1](./zb-api-verification.md) — quotes the `create-a-job` page |
| Failed POST payload | `zb_outbound_commands.payload_json` for id `eb778119...` (queried via Supabase management API 2026-05-19) |
| ZB 400 response body | `zb_outbound_commands.zb_response` same row |
| Inbound mapper | [zenbooker-sync.js mapJob lines 342–424](../../zenbooker-sync.js#L342-L424) — shows ZB's *response* shape for a job object (informs but does not equal request shape) |
| Discovery for sibling endpoints | [zb-api-verification.md §3.4](./zb-api-verification.md) — the `/assign` discovery is the closest analog: 3 wrong-field 400s told us the actual contract |

---

## 1. Summary table

Audit verdict per top-level field emitted today in [lib/zb-outbound-producer.js buildZbBody at lines 198–226](../../lib/zb-outbound-producer.js#L198-L226):

| # | Top-level field | Required? | Field name evidence | Value evidence | Live acceptance? | Verdict |
|---|---|---|---|---|---|---|
| 1 | `territory_id` | Required | **D** (docs) | **C** (roundtrip from `territories.zenbooker_id`) | None | **VERIFIED-NAME, INFERRED-LIVE** |
| 2 | `customer_id` | Required (XOR `customer` object) | **D** (docs) | **C** (roundtrip from `customers.zenbooker_id`) | None | **VERIFIED-NAME, INFERRED-LIVE** |
| 3 | `services` (array of objects) | Required | **D** (docs say "array of objects") | **E** (we emit `[{service_id: <id>}]` — inner key is INFERENCE) | None | **PARTIAL — sub-key `service_id` is INFERENCE** |
| 4 | `timeslot` (object) | Required (XOR `timeslot_id`) | **D** (docs say "object") | mixed (see §3) | None | **PARTIAL — sub-keys partly REFUTED, partly INFERRED** |
| 5 | `address` (object) | Required (XOR `address_id`) | **D** (docs say "object") | **E** (sub-keys `line1`/`city`/`state`/`postal_code` are inferred from response shape, not from request docs) | None | **PARTIAL — sub-keys are INFERENCE** |
| 6 | `assigned_providers` (array of strings) | Optional | **D** (docs) | **C** (roundtrip from `team_member_provider_mappings.zenbooker_provider_id`) | None | **VERIFIED-NAME, INFERRED-LIVE** |
| 7 | `assignment_method` (`"auto"` / `"offer"`) | Optional | **D** (docs) | **D** (docs list enum) | None | **VERIFIED-NAME, INFERRED-LIVE** |
| 8 | `duration` (number, minutes) | Optional | **D** (docs) | **D** (docs say "number, minutes") | None | **VERIFIED-NAME, INFERRED-LIVE** |
| 9 | `notes` | Optional? | **E** (NOT in docs §3.1 optional-field list — producer emits anyway) | n/a | None | **UNVERIFIED — likely silently ignored OR potential 400 risk** |

**Top-level field count emitted:** 9. **Verified by docs:** 7 names. **Inference-driven sub-keys:** 3 fields (`services[].service_id`, `timeslot.*`, `address.*`). **Refuted by today's evidence:** 1 sub-key (`timeslot.start_time` → must be `timeslot.start`). **Not in docs:** 1 field (`notes`).

---

## 2. Field-by-field — top-level

### 2.1 `territory_id`

| Aspect | Evidence | Tier |
|---|---|---|
| Name `territory_id` | Public docs: "Required: `territory_id` (string)" | D |
| Required vs optional | Docs: required | D |
| Value `1774549605695x331883119954100200` | We pulled it from `territories.zenbooker_id` which was populated by inbound sync from ZB itself | C |
| ZB accepts this value | Not yet falsified by ZB. The 400 was on `timeslot.start`, not `territory_id`. **But:** ZB may short-circuit validation at the first missing required field, so silence on `territory_id` is weak evidence. | (gap) |

**Verdict: Name VERIFIED. Value format VERIFIED (we wrote what ZB sent us). Live acceptance UNVERIFIED — need 2xx to close.**

### 2.2 `customer_id`

| Aspect | Evidence | Tier |
|---|---|---|
| Name `customer_id` | Public docs: "Required: either `customer` (object) or `customer_id` (string)" | D |
| We chose `customer_id` over `customer` object | Producer emits `customer_id`. Docs explicitly support either. | D |
| Value | Roundtrip from `customers.zenbooker_id`. | C |
| Live acceptance | Same caveat as `territory_id` — not yet falsified, not yet confirmed. | (gap) |

**Verdict: same as territory_id. Name VERIFIED, value VERIFIED, live UNVERIFIED.**

### 2.3 `services` (array of objects)

| Aspect | Evidence | Tier |
|---|---|---|
| Top-level field name `services` | Public docs: "Required: `services` (array of objects)" | D |
| Sub-key inside each object | **NOT in public docs.** Producer emits `{service_id: <id>}`. The inner key `service_id` is inferred — could be `id`, `service_id`, or anything else. | E |
| Value | Roundtrip from `services.zenbooker_id`. | C |
| Live acceptance | Not yet probed (400 happened before this could be validated). | (gap) |

**Concern:** Sibling pattern matters. Inbound sync's `mapService` (zenbooker-sync.js line 128) reads `zb.service_id || zb.id` — meaning ZB's service objects expose **both** `service_id` AND `id`, and we don't know which one the request body's `services[].x` key expects. The bias would be that on a job object, ZB references services by `service_id` (we see this in our inbound mapper assumption). But this isn't proven for the create body.

**Verdict: Top-level name VERIFIED. Inner sub-key `service_id` is INFERENCE — needs explicit verification.**

### 2.4 `timeslot` (object)

This is the field that broke today. Audit per sub-key:

| Sub-key (as we emit) | Value example | Evidence for this name | Tier | Status |
|---|---|---|---|---|
| `timeslot.type` | `"specific_time"` | NOT in public docs. Inferred. ZB didn't reject it in the 400 — but ZB likely short-circuited at the missing `start` check, so silence here is not acceptance. | E | UNVERIFIED — possibly correct, possibly silently ignored, possibly will 400 next attempt |
| ~~`timeslot.start_time`~~ | `"2026-05-21T13:30:00Z"` | Live POST 2026-05-19 returned `400 INVALID_TIME_SLOT — timeslot.start is required`. | F | **REFUTED** — must be removed |
| `timeslot.start` (proposed) | `"2026-05-21T13:30:00Z"` | Tier B (live negative): the 400 message names the field directly. | B | **VERIFIED-NAME by negative evidence**. Value format (ISO 8601 `Z`) inferred from sibling endpoint (`reschedule.start_date` per docs §3.2). Live acceptance pending. |

**Other potential sub-keys we do NOT currently emit but might need:**

- `timeslot.end` — ZB might require explicit end (Tier E inference: probably derived from `duration` and not required separately, but unconfirmed).
- `timeslot.timezone` — the response-side `zb.timezone` exists (mapJob line 377). Whether the request side needs it is Tier E.
- `timeslot.arrival_window_minutes` — appears on reschedule body per docs §3.2; could plausibly also appear on create. Tier E.

**Verdict: `timeslot.start` is the only sub-key with positive evidence (negative-derived). `timeslot.type` is INFERENCE. End/timezone/arrival_window are unknowns.**

### 2.5 `address` (object)

| Sub-key (as we emit) | Value example (from failed POST) | Evidence | Tier |
|---|---|---|---|
| `address.line1` | `"1372 6th Street Northwest"` | Inferred from RESPONSE shape: inbound mapper reads `zb.service_address.line1` (mapJob line 378). Request shape may differ. | E |
| `address.city` | `"Winter Haven"` | Same — response sub-key is `city`; request inferred-same. | E |
| `address.state` | `"Florida"` | Inferred. Value format also unverified — ZB might require ISO code (`"FL"`) on input even though response stores the long name. The customer record came from ZB so `"Florida"` was ZB-minted, but that's at the customer level, not the job-create body. | E |
| `address.postal_code` | `"33881"` | Inferred from response shape (`zb.service_address.postal_code`). | E |

**Sibling endpoint check:** Public docs `create-a-customer` (§3.5) optionally accepts `addresses` (array) — sub-key shape not visible in our doc references. Could be `line_1`, `address_line_1`, `street`, etc.

**Risk:** The `timeslot` failure shows ZB does NOT keep response field names = request field names (response uses `start_date` on the job object, request uses `timeslot.start`). Same asymmetry can plausibly apply to `address.*`. We are taking ZB's response object and feeding it back as request input, which felt safe but is exactly the assumption today's bug invalidated.

**Verdict: All four `address.*` sub-keys are INFERENCE. Value format on `state` is INFERENCE. Could equally fail with a 400 on the next live attempt as a different field name.**

### 2.6 `assigned_providers` (array of strings)

| Aspect | Evidence | Tier |
|---|---|---|
| Field name | Public docs: "Optional: `assigned_providers` (array of strings — provider IDs)" | D |
| Value | Roundtrip from `team_member_provider_mappings.zenbooker_provider_id`. | C |
| Live acceptance | Not falsified. Sibling endpoint `/assign` discovery (zb-api-verification §3.4) showed ZB uses `assign[]`/`unassign[]`/`notify` on the mutation endpoint, NOT `assigned_providers`. **But for the CREATE body, docs explicitly list `assigned_providers` as the optional field name — so the create-time and modify-time field names are different.** Inconsistent across ZB endpoints but explicitly documented for create. | D |

**Verdict: Name VERIFIED by docs. Value VERIFIED by roundtrip. Live UNVERIFIED — but high confidence.**

### 2.7 `assignment_method`

| Aspect | Evidence | Tier |
|---|---|---|
| Field name | Docs: "`assignment_method` (`"auto"` | `"offer"`)" | D |
| Value `"auto"` | Docs list it as a valid enum value. | D |
| Live acceptance | Not yet falsified. | (gap) |

**Verdict: VERIFIED by docs. Live confirmation pending.**

### 2.8 `duration`

| Aspect | Evidence | Tier |
|---|---|---|
| Field name | Docs: "`duration` (number, minutes)" | D |
| Value `330` (we emit `Number(sfJob.duration)`) | SF jobs.duration is stored as integer minutes (verified by reading the SF schema). 330 minutes = 5.5 hours, plausible. | C/E |
| Unit | Docs say "minutes" — we emit minutes. | D |
| Live acceptance | Not yet falsified. | (gap) |

**Verdict: VERIFIED by docs. Live confirmation pending.**

### 2.9 `notes`

| Aspect | Evidence | Tier |
|---|---|---|
| Field name | **NOT in the §3.1 optional-field list.** Public docs do not mention `notes` on `create-a-job`. | E |
| Producer behavior | [lib/zb-outbound-producer.js:223](../../lib/zb-outbound-producer.js#L223) emits `body.notes = String(sfJob.notes).slice(0, 1000)` if `sfJob.notes` is set. | (code) |
| Value example | Today's failed POST: SF job 142206 had no `notes`, so this was OMITTED. The field was not exercised. | n/a |
| Live acceptance | Untested. Risk profile: ZB either silently ignores unknown fields (typical REST) or 400s on them (stricter APIs). Sibling `create-a-customer` (§3.5) has `notes` as an explicit field, but per its docs `notes` is `array` not `string` on customers — names overlap but shapes don't. Cannot assume jobs accepts a string `notes`. | (gap) |

**Verdict: UNVERIFIED. **Recommended action: remove `notes` from the producer's `job.create` body until ZB documents support OR live evidence confirms acceptance.** Move SF's job notes to an SF-only field; do not attempt to push them to ZB until verified.

---

## 3. Sub-field deep dive — `timeslot`

### 3.1 What we know

- `timeslot.start` is required (Tier B — direct from today's 400).
- The value format is ISO 8601 with `Z` suffix (inferred from reschedule's `start_date` per docs §3.2, which lists `"2020-09-22T13:00:00.000Z"` as the example).

### 3.2 What we don't know

- Whether `timeslot.type` is a valid field at all.
- If `type` is valid: what enum values exist (`"specific_time"`, `"window"`, `"flexible"`, etc.).
- Whether `timeslot.end` is required, optional, or unsupported.
- Whether `timeslot.timezone` is supported (and if so: IANA name, offset, or both?).
- Whether `timeslot.arrival_window_minutes` carries over from the reschedule endpoint.
- Whether ZB requires the time component to align with territory business hours.

### 3.3 Minimal experiment to close §3.2 gaps

Out of scope for this doc (no live writes). Captured as Q12–Q16 below.

---

## 4. Sub-field deep dive — `address`

### 4.1 What the inbound mapper reads (line 346–381)

```js
const addr = zb.service_address || {}
// then reads: addr.line1, addr.formatted, addr.city, addr.state, addr.postal_code
```

So response-side sub-keys are: `line1`, `formatted`, `city`, `state`, `postal_code`.

### 4.2 What the producer emits (line 174–179)

```js
sf_address: {
  line1: sfJob.service_address_street || null,
  city: sfJob.service_address_city || null,
  state: sfJob.service_address_state || null,
  postal_code: sfJob.service_address_zip || null,
},
```

### 4.3 The asymmetry risk

The producer's assumption: request body uses the same keys ZB uses in its response object (`service_address` minus the wrapper, exposing `line1` etc.). This is exactly the assumption that broke today on `timeslot` (response is `start_date`, request is `timeslot.start`).

Sub-key candidates we have not falsified or confirmed:
- `line1` vs `line_1` vs `address_line_1` vs `street`
- `state` as `"Florida"` vs `"FL"` vs `state_code` vs `state_name`
- `postal_code` vs `zip` vs `zip_code` vs `postcode`

### 4.4 Mitigating factor

ZB's docs at §3.5 (customer create) list `addresses` (plural) as an array with object shape, suggesting ZB internally has a stable address object schema. If we can extract that schema (Q14), we'll likely know what `address` looks like on the job-create body too. Until then: INFERENCE.

---

## 5. Other documented optional fields the producer does NOT currently emit

These are not part of today's failed payload but listed for completeness — any of them might be needed once Phase B expands or in adjacent commands:

| Field | Type | Tier | Notes |
|---|---|---|---|
| `required_skills` | array of strings | D | Optional. Not modeled in SF today. |
| `min_providers_needed` | string | D | Docs say "string" (unusual — likely numeric-as-string). |
| `manual_payment_method` | string | D | Optional payment override. Not modeled in SF. |
| `sms_notifications` | bool | D | Per-job toggle. |
| `email_notifications` | bool | D | Per-job toggle. |
| `tax_exempt` | bool | D | Tax override. |
| `job_number` | string | D | Operator-friendly identifier. SF has `jobs.job_number`-equivalent; could be mapped if we want ZB to display SF's number. |

Producer scope decision: keep these out of the Phase B body until they're individually justified. Smaller body = smaller surface to validate.

---

## 6. Recommended remediation matrix (documentation only — no code in this artifact)

| # | Action | Owner | Effort | Blocks unfreeze? |
|---|---|---|---|---|
| R1 | Replace `timeslot.start_time` → `timeslot.start` in [lib/zb-outbound-producer.js:210](../../lib/zb-outbound-producer.js#L210). One line. | Backend lead | 5 min | **Yes** (the original bug) |
| R2 | Fix three false-green test assertions in [tests/zb-outbound-producer.test.js](../../tests/zb-outbound-producer.test.js) (lines 83, 88, 94) to assert `start` instead of `start_time`. Add 2 new tests asserting absence of `start_time` and absence of SF-style aliases. | Backend lead | 15 min | **Yes** |
| R3 | Remove `notes` emission from `buildZbBody` (line 223) until ZB acceptance verified. SF retains `notes` locally. | Backend lead | 5 min | **Yes** (precaution; avoid second contract surprise) |
| R4 | Open ZB support ticket asking explicit per-field confirmation for the 9 fields in §1 + the 6 timeslot/address sub-keys. Use the template in [zb-support-questions.md] adapted for create-body specifics. | Operator → ZB support | 1 day to file, days–weeks for reply | No (parallel — file but don't block on reply if we re-arm before it lands) |
| R5 | After R1+R2+R3 land and one live POST succeeds, capture the 2xx response body and append it to this audit as Tier A evidence for the seven verified-by-docs-but-not-yet-by-2xx fields. | Operator (post-soak) | 1 hour | No |
| R6 | Promote Q12–Q17 (below) to the §13 open-questions table in [zb-outbound-command-confirmation.md](./zb-outbound-command-confirmation.md). | Doc maintainer | 10 min | No |

---

## 7. New open questions (consequence of today's incident)

| # | Question | How to resolve |
|---|---|---|
| Q12 | Is `timeslot.type` a real field? If yes, what enum values? | Live experiment with `timeslot: {start: ..., type: "specific_time"}` and `timeslot: {start: ...}` (no type) — compare 2xx vs 400 |
| Q13 | Does `timeslot` require `end`, or does ZB compute it from `duration`? | Live experiment without `end` + with `duration` |
| Q14 | What are the actual sub-keys of the `address` object in the create body? | Live experiment — try `line1` first (matches response); if 400, try `address_line_1`, `street`. **Bounded discovery — ≤3 attempts.** |
| Q15 | Does `address.state` accept long names (`"Florida"`) or ISO codes (`"FL"`) only? | Live experiment — start with long name (matches response shape) |
| Q16 | Does `services[]` use sub-key `service_id` or `id` or something else? | Live experiment — try `service_id` first (matches existing producer); if 400, try `id` |
| Q17 | Does ZB silently ignore unknown fields like `notes`, or does it 400? | Once R3 removes `notes`, send a known-good payload; then add `notes` back as a separate experiment |

These questions are interdependent: Q12 and Q13 share a payload, Q14 and Q15 share a payload. A minimum of **two** carefully-staged live POSTs (each on a throwaway pilot-tenant job) can close Q12–Q16. Q17 is an isolated experiment.

---

## 8. Lessons captured

### 8.1 Dry-run is not a contract test
Dry-run mode validates that the producer emits the payload the producer intends to emit. It does not validate that the payload matches ZB's contract. The only way to verify ZB's contract is a live POST against ZB and inspection of the response. Future phase activations must allocate a **controlled live verification step** that is distinct from dry-run soak.

### 8.2 Roundtripping ZB ids is safe; roundtripping ZB field names is not
We mistakenly extended "the IDs ZB sends us are the IDs ZB expects back" to "the field names ZB sends us are the field names ZB expects back." The former is true (Tier C); the latter is not (today proved this for `timeslot`).

### 8.3 Tests that mirror producer assumptions are not regression tests
Three test assertions explicitly checked for `start_time`. They all passed against wrong code. A test that bakes the same assumption as the implementation is a tautology, not a contract test. New contract tests must reference an external authority (docs string, captured 2xx body, ZB support reply quoted in the test).

### 8.4 "Documented" is necessary but not sufficient
Of 9 emitted fields, 7 had Tier-D doc evidence and 1 had Tier-D-refuted (`timeslot.start_time`). Docs are necessary but the bug existed in the gap between top-level docs ("required: `timeslot` (object)") and sub-key specifics (which docs did NOT enumerate). Audits like this one must drill below the documented top-level shape into every emitted sub-key.

---

## 9. Closeout requirements (for this doc to mark Amendment B as satisfied)

- [x] Every top-level field in the failed payload classified per evidence tier.
- [x] Every sub-key in nested objects (`timeslot.*`, `address.*`, `services[].*`) classified.
- [x] All inferences explicitly flagged.
- [x] Refuted assumption (`timeslot.start_time`) documented with its evidence.
- [x] Open questions (Q12–Q17) captured.
- [x] Recommended remediations (R1–R6) listed with owners.
- [x] Lessons captured.

This document satisfies **Amendment B (OQ9 promoted to pre-unfreeze requirement)** of design v0.6.

---

## 10. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-19 | 0.1 | Initial audit. Triggered by `timeslot.start` incident. 9 top-level fields classified; 5 sub-keys flagged as inference; 6 new open questions (Q12–Q17); 6 remediations (R1–R6). |
