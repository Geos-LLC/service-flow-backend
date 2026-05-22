# Future Integration Strategy

**Status:** Forward-looking design constraints for upcoming integrations
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [new-integration-requirements.md](new-integration-requirements.md) — concrete checklist for adding a new integration
- [identity-graph-refactor-plan.md](identity-graph-refactor-plan.md) — overall architecture
- [identity-enforcement-roadmap.md](identity-enforcement-roadmap.md) — code-enforcement progression
- [transitional-infrastructure-registry.md](transitional-infrastructure-registry.md) — what cannot grow

---

## 1. Why this document exists

We have ~5 integrations today (LB, ZB, OP, SF, Sigcore). The roadmap
suggests we may add ~8 more in the next 18 months:

- **CRM/Ops platforms:** Jobber, Housecall Pro, ServiceTitan, HubSpot
- **Messaging:** WhatsApp, Telegram, Gmail
- **AI surfaces:** AI agents (Claude/GPT-driven workflow automation that
  acts ON BEHALF of operators)

Each integration arrives with its own data model, identity model, and
operational gravity. Without an explicit strategy, each one will either:

1. Get its own bespoke ingestion path (multiplying transitional code).
2. Be force-fit into the LB adapter mold (and break in subtle ways).
3. Skip the engine entirely "for speed" (and become the next item in the
   transitional infrastructure registry).

This doc defines the **classification framework** that determines how
each new integration plugs in.

> **Non-goal:** This is not an implementation plan for any specific
> integration. It defines the contract; the integration's PR provides
> the implementation.

---

## 2. Integration classification (the four classes)

Every new integration fits into one of these four classes. Class
determines the adapter shape, the per-tenant rollout, and the
transitional-debt budget.

### 2.1 Class I — Source-of-truth CRM

**Examples:** Jobber, Housecall Pro, ServiceTitan, future Service Flow
"native CRM" mode.

**Characteristics:**
- The integration is itself a CRM. The tenant runs their business on it.
- Customers/leads/jobs/invoices live in the external system.
- Service Flow projects from it but does NOT own the data.

**Identity model:**
- Each entity in the source has a stable `external_id` (e.g., Jobber
  `customer_id`).
- Source's notion of "customer" maps to Service Flow's
  `communication_participant_identities` row (the canonical identity).
- Service Flow's `customers` and `leads` tables are projections of the
  source — they should NEVER be the destination of operator edits that
  don't propagate back.

**Adapter shape:**
- Read-mostly. Webhook ingestion + scheduled diff sync.
- Write-back is optional and tenant-controlled (some tenants want SF →
  source flow, others don't).
- The adapter MUST call the engine for every ingested entity. Engine
  decides identity attribution.
- No fallback bridge needed if the source `external_id` is reliable —
  the engine resolves identity by `external_id` first.

**Rollout posture:**
- Bronze → Silver → Gold per tenant. Start with sync-only (no write-back).
- Source-of-truth CRMs are the slowest to roll out (most write paths to
  audit, highest blast radius).

### 2.2 Class II — Sales/marketing intake

**Examples:** LeadBridge (current), HubSpot (future), Yelp Inbox, future
"lead capture form" tools.

**Characteristics:**
- The integration is a SOURCE of leads (and sometimes customer enrichment).
- It does not represent a customer's full lifecycle — only the
  pre-customer or marketing-touch state.
- Service Flow IS the system of record once a lead becomes a customer.

**Identity model:**
- Each lead has an external lead id from the source.
- The engine's job is to decide whether this lead is the same person as
  an existing customer/lead in Service Flow (the cardinality decision).
- Reactivation, repeat-acquisition, and first-touch outcomes are all in
  scope (see `lead-cardinality-and-parent-lead-id.md`).

**Adapter shape:**
- Webhook-driven (events flow in). Engine returns a plan describing
  identity decision + lead creation cardinality.
- Always call the engine; never write directly from the adapter.
- Backfill is one-shot per tenant; the registered backfill bypass
  (Registry §1.5) is the model.

**Rollout posture:**
- Same Bronze→Silver→Gold model. LB is the prototype.
- High-volume integrations (LB, Yelp) need the rate-limited warn
  pattern (§1.2 in registry).

### 2.3 Class III — Communication channel

**Examples:** OpenPhone (current), WhatsApp (current, in Sigcore),
Telegram (future), Gmail (future), SMS via Twilio.

**Characteristics:**
- The integration carries messages (SMS, MMS, voice, email, IM).
- A message is NOT a lead or a customer — it's evidence that an identity
  was active.
- Identity attribution comes from the channel address (phone, email).

**Identity model:**
- Each conversation participant is keyed by `(channel, normalized_address)`.
- The engine maps this to an identity row, creating one if needed.
- Lead/customer creation is a SECONDARY effect — gated by the OP-style
  "should we create a lead from this conversation" decision.

**Adapter shape:**
- Webhook → engine → identity hydration → optional lead/customer
  projection.
- The engine's plan for Class III often looks like:
  `{kind: 'matched', identity: <existing>, plan: [{action: 'noop'}]}`
  because most messages don't change CRM state.
- Direct writes to `sf_lead_id`/`sf_customer_id` (current OP bypass) are
  Class III's biggest debt to retire.

**Rollout posture:**
- Slower than Class II because the projection decision (create lead from
  message? attach to existing customer?) involves more heuristics.
- Per-channel decision logic lives in adapter, not engine.

### 2.4 Class IV — AI agent / autonomous actor

**Examples:** Claude/GPT-driven workflow assistants, AI auto-responders,
agentic tools that act on behalf of an operator.

**Characteristics:**
- The integration is software acting WITHOUT a human operator's
  immediate consent on each action.
- It can read identity state. It can request engine actions. It can
  surface ambiguity to a human.
- It MUST NOT have direct write access to identity rows, CRM tables, or
  source-system APIs.

**Identity model:**
- AI agent IS NOT an identity. It's an actor that operates on identities.
- All AI-initiated state changes go through the same authorisation +
  audit path as operator-initiated changes.
- AI actions are tagged with `resolved_by='ai_agent'` AND a
  `agent_id`/`actor_id` field linking to the human operator they're
  acting on behalf of.

**Adapter shape:**
- Read-side: the agent gets a scoped read API (identity + CRM lookups,
  rate-limited).
- Write-side: agent calls the same operator-override endpoints a human
  uses (`applyLeadCustomerLink`, `setIdentityCustomer` via API), with
  agent-specific auth.
- Engine + linker know about `actor_type='ai_agent'` and refuse certain
  writes (mass merges, retroactive repair runs).

**Rollout posture:**
- Slowest of all four classes. AI agents amplify both correctness and
  errors.
- Start in read-only mode for every tenant. Enable specific write
  actions one at a time, behind per-tenant flags.
- Every AI write requires a human-readable explanation in the audit log
  ("agent X performed Y because Z").

---

## 3. Class-by-class design contracts

### 3.1 Class I — Jobber, Housecall Pro, ServiceTitan, HubSpot

**The adapter must:**
1. Implement `jobberAdapter.syncCustomer(externalId)` that calls the
   engine with `{source: 'jobber', externalId, ...}` and returns the
   identity row.
2. Persist the integration's API token in `integration_credentials` table
   (already exists for LB / ZB).
3. Emit `[<Source>Sync] event=customer_synced` per event to Loki.
4. Honor `IDENTITY_PROJECTION_FREEZE` — sync continues hydrating
   identities but does NOT update `customers.*` projection fields.
5. Pre-flight check: source's `external_id` must be stable. If the
   source can re-issue IDs (rare), the adapter MUST normalize them.

**The engine adds:**
- New `source` enum value (e.g., `'jobber'`) in resolution policies.
- A new `decideForJobber()` decision function in
  `lib/identity-reconciliation-engine.js`.

**The schema adds:**
- New `external_id` column variant if needed (e.g., `jobber_customer_id`
  on `communication_participant_identities`). Indexed.

**Tenant rollout:**
- S0 dark code → S1 dry-run sync (read-only, log plan) → S2 shadow write
  (writes to a side-table for verification) → S3 co-pilot (real writes
  but legacy path is fallback if needed) → S4 authoritative.

**Transitional debt budget:** ZERO. Class I integrations land directly
into the adapter pattern. Any direct write to identity/CRM tables from
within the adapter is a CI scanner error, not a transitional warning.

### 3.2 Class II — HubSpot, Yelp Inbox (Class II uses)

**The adapter must:**
1. Implement webhook signature verification at the route handler.
2. Translate the source's lead payload into the engine's input shape.
3. Call `reconcile(supabase, logger, input, policy)` and execute the
   returned plan via the projection-layer linker (`setIdentityLead`,
   `applyLeadCustomerLink`).
4. Handle the cardinality model (`parent_lead_id` + `lead_origin_type`)
   if the tenant is on `LEAD_CARDINALITY_CHILD_LEADS_TENANTS`.
5. Emit `[<Source>] path=engine reason=<reason>` per webhook.

**The engine adds:**
- `decideFor<Source>()` decision function.
- Per-integration confidence thresholds (must not widen LB's existing
  thresholds — see `cross-source-identity-reconciliation.md` §3).

**Tenant rollout:**
- Same per-tenant gated rollout as LB.

**Transitional debt budget:** Backfill bypass allowed (one-shot, per
tenant, instrumented per registry §1.5). No other bypasses permitted.

### 3.3 Class III — WhatsApp, Telegram, Gmail

**The adapter must:**
1. Implement channel-specific identity key extraction:
   - WhatsApp: E.164 phone, with `channel='whatsapp'`
   - Telegram: `tg_user_id`, with `channel='telegram'`
   - Gmail: normalized email, with `channel='email'`
2. Call the engine for each message ingestion. Engine returns identity
   row + optional projection plan.
3. Implement the channel-specific "create lead from conversation"
   decision in the adapter (like OP's `maybeCreateLeadFromOpenPhone`,
   but inside the adapter, not in server.js).
4. NEVER write `sf_lead_id` / `sf_customer_id` directly. Always via
   `setIdentityLead` / `setIdentityCustomer`.

**The engine adds:**
- Channel-aware identity lookup (`channel + normalized_address` →
  identity row).
- Per-channel rules for when to create a lead (encoded in
  `decideFor<Channel>()`).

**Channel-specific considerations:**

| Channel | Identity key | Gotchas |
|---------|--------------|---------|
| WhatsApp | E.164 phone | Same phone may be on SMS too — treat as same identity unless tenant configures otherwise |
| Telegram | tg_user_id | Telegram users can change their phone; only `tg_user_id` is stable |
| Gmail | normalized email | Aliases (`user+tag@`) collapse to the same identity by default; tenant can override |

**Tenant rollout:**
- Same per-tenant gated rollout.

**Transitional debt budget:** ZERO. WhatsApp/Telegram/Gmail land in the
adapter pattern; the current OP direct-link bypass (registry §1.3) is
the model of what NOT to do.

### 3.4 Class IV — AI agents

**The agent must:**
1. Authenticate as a service account scoped to a specific tenant +
   actor (human operator on whose behalf it acts).
2. Read identity state via a scoped read API
   (`GET /api/v2/identities/:id` etc.). No raw DB access.
3. Write identity state only through operator-override endpoints (NEVER
   raw SQL, NEVER direct linker calls).
4. Emit `[AIAgent] action=<verb> actor=<operator-id> tenant=<id>
   reasoning="<short text>"` per action.
5. Surface ambiguity to the human operator via the existing Identity
   Conflicts UI (do not invent a new approval surface).

**The engine adds:**
- `actor_type` parameter to the reconciliation policy: `'human' |
  'ai_agent'`. AI agent decisions get more conservative confidence
  thresholds.
- Refusal of mass operations (merge ≥ 10 rows, retroactive repair) for
  `actor_type='ai_agent'`.

**The schema adds:**
- `identity_link_audit.actor_type` column. `'human' | 'ai_agent' |
  'system'`.
- `identity_link_audit.agent_reasoning` text column. Required when
  `actor_type='ai_agent'`.

**Tenant rollout:**
- Start every tenant in READ-ONLY mode. Agents can read identities,
  surface ambiguity, summarize state — but cannot write.
- Per-action enablement: explicit `AGENT_CAN_<ACTION>_TENANTS` env var
  for each write capability (link lead, unlink, create lead, etc.).
- No Bronze tenant gets any write action.

**Transitional debt budget:** ZERO. AI agents are new code; no legacy
to be transitional from.

---

## 4. Cross-cutting design rules

These rules apply to ALL future integrations regardless of class.

### 4.1 The engine is the only decision-maker

No new integration adapter contains identity-matching logic. Matching
heuristics live ONLY in `lib/identity-reconciliation-engine.js`
(and its per-source `decideFor*` helpers).

**Why:** today there are 4 decision functions; growing to 12 will
explode the matching-logic surface if every adapter ships its own.

### 4.2 The linker is the only writer

No new integration adapter writes to `customers`, `leads`,
`communication_participant_identities`, or any identity-projection
column directly. ALL writes go through:

- `setIdentityLead` / `setIdentityCustomer` (identity row sf_* fields)
- `projectIdentityToCRM` (CRM-side projections from identity state)
- `applyLeadCustomerLink` (operator-override lead↔customer linking)

**Why:** the linker enforces audit, idempotency, and provenance. Adapter
writes that bypass it become the next entries in the transitional
infrastructure registry.

### 4.3 Confidence thresholds are not negotiable

A new integration cannot ship with lower confidence thresholds than LB.
"My integration's matching is easier so I can be more permissive" is
NEVER a valid argument — the engine's confidence policy is global.

If a new integration genuinely needs different matching, the discussion
happens via RFC against `identity-reconciliation-engine-design.md`, not
in the adapter PR.

### 4.4 Per-tenant rollout is mandatory

Every new integration ships with `RECONCILIATION_ENGINE_<INTEGRATION>_TENANTS`
flag. Default empty (S0). Tenant onboarding follows the governance doc
ritual.

No global-on integrations. Ever. Even "small" integrations get the
per-tenant flag.

### 4.5 Observability is a launch blocker

A new integration cannot ship to production without:

- Loki labels that distinguish it (`[<Integration>]` log prefix)
- A `path=engine` / `path=legacy` distinction (if there's a legacy path)
- A Grafana panel showing per-tenant adapter coverage
- An entry in `reconciliation-health-dashboard.md`

### 4.6 Transitional code requires explicit registration

If a new integration MUST have a transitional bypass (e.g., a short-term
direct write while the engine catches up), the PR must:

1. Add the `recordTransitionalBypass` call site.
2. Add a `@transitional` / `@owner:` / `@retirement-stage:` /
   `@observability:` comment block (CI scanner enforces).
3. Add an entry to `transitional-infrastructure-registry.md` with a
   removal prerequisite.
4. Add a retirement gate to `fallback-retirement-gates.md` if numeric
   thresholds are warranted.

Skipping any of these is grounds for PR rejection.

### 4.7 Schema additions are reviewed against the "No duplicate graph truth" invariant

Reverse pointers (e.g., a new `<table>.canonical_identity_id` column)
require an RFC, not just a migration. See
`identity-graph-refactor-plan.md` §3.2a.

The default position is NO reverse pointer — JOIN through the identity
graph or accept the table can't answer the question.

### 4.8 Multi-tenancy is RLS + `user_id`, not adapter heuristics

A new integration does NOT implement tenant isolation in the adapter
layer. Tenant isolation is:

1. RLS policy on the table (already there for all identity tables).
2. `user_id` filter in every query.
3. Per-tenant feature flag enable.

If an adapter is tempted to "filter to tenant X" via application logic,
something is wrong with the data model.

---

## 5. Anti-patterns to refuse

### 5.1 "Just for this integration, can we ..."

Every "just for this" exception adds a permanent transitional debt.
Default: NO. The integration adapts to the architecture, not the
reverse.

Acceptable exceptions: data-shape translation, source-specific
normalization, source-specific timeout handling. These live in the
adapter and never touch the engine or linker.

### 5.2 "We'll add the engine integration later, just ship the webhook now"

NO. The webhook handler is part of the adapter; it must call the engine
from day one. Shipping a webhook handler that writes directly to
`leads` / `customers` creates the next transitional bypass.

### 5.3 "This integration is read-only, so we don't need the audit table"

Read-only integrations still produce identity-row updates (creating an
identity for a participant the first time we see them counts as a
write). The audit table covers it.

The exception would be a true zero-write integration (e.g., a reporting
exporter that JOINs across our tables and produces a CSV). That's not
an integration in the sense of this document.

### 5.4 "Let's just copy the LB adapter and rename things"

LB adapter has 18 months of accumulated transitional behaviour. Copying
it preserves that history. New integrations should reference
`new-integration-requirements.md` and the engine API, NOT inherit LB's
quirks.

### 5.5 "Per-tenant flag is overkill for our 3 pilot customers"

No it's not. Three pilots is exactly the case where you want per-tenant
flexibility — one of them is going to misbehave first and you want to
demote them without affecting the other two.

---

## 6. Integration-by-integration sketch

These are starting positions, not commitments. Each integration's
detailed design lives in its own RFC.

### 6.1 Jobber (Class I)

- **Identity key:** Jobber `customer_id`. Stable per their API docs.
- **Webhook events:** `customer.created`, `customer.updated`,
  `job.created`, `invoice.paid`.
- **Engine integration:** `decideForJobber()` with `external_id` first,
  phone/email/name fallback at high confidence only.
- **First milestone:** sync customers (read-only). No write-back to
  Jobber in v1.
- **Pilot tenant rollout:** S0 → S1 over 30d.

### 6.2 Housecall Pro (Class I)

- Similar to Jobber. HCP has a richer job-state model; the engine
  initially ignores job state and only attributes customer identity.

### 6.3 ServiceTitan (Class I)

- Largest of the Class I integrations. ServiceTitan tenants are typically
  larger; rollout windows accordingly longer.

### 6.4 HubSpot (Class II)

- Webhook on contact create/update. HubSpot contacts map to leads (not
  customers, since HubSpot is marketing-side).
- Cardinality model applies: returning contacts produce reactivation
  leads.

### 6.5 WhatsApp (Class III)

- Already exists in Sigcore repo (see memory: `project_whatsapp_sigcore`).
- Identity key: E.164 phone, `channel='whatsapp'`.
- Same phone on SMS and WhatsApp → same identity row by default.

### 6.6 Telegram (Class III)

- Identity key: `tg_user_id`. Phone is secondary.
- Phone-to-tg-id mapping is one-way and lossy (operators can have many
  phones; tg ids are stable).

### 6.7 Gmail (Class III)

- Identity key: normalized email (lowercase, strip `+tag` aliases).
- Threading: an email thread is a conversation; the first email may
  create a lead, subsequent ones don't.

### 6.8 AI agents (Class IV)

- Initial rollout: read-only assistant that surfaces "you have N
  unlinked leads that look like X" — no writes.
- Phase 2: assistant can propose links via the Identity Conflicts UI
  (human approves).
- Phase 3 (months out): assistant can auto-execute high-confidence
  conflict resolutions for Gold tenants only.

---

## 7. Cross-references

When designing a new integration, consult in this order:

1. **This document** — what class does it fit?
2. **`new-integration-requirements.md`** — concrete adapter checklist.
3. **`identity-graph-refactor-plan.md`** — overall architecture.
4. **`identity-reconciliation-engine-design.md`** — how to add
   `decideFor<Source>()`.
5. **`identity-rollout-governance.md`** — how to roll out to tenants.
6. **`transitional-infrastructure-registry.md`** — what NOT to add to.
7. **`fallback-retirement-gates.md`** — if transitional debt is unavoidable.

---

## 8. Review cadence

- **Per new integration PR:** identity-v5 owner reviews the class
  classification before any code is merged.
- **Annually:** revisit class definitions. New classes may be needed
  (e.g., if "AI agents" splits into "AI assistants" vs "autonomous
  agents," the framework gets a Class V).
- **After every transitional bypass added to the registry from a NEW
  integration:** retrospective on why the strategy didn't prevent it,
  and what to add to this doc.
