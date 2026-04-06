Use this task for the AI agent:

---

# TASK — Fix Migration 006 Before Running

## File

`migrations/006_leadbridge_communication_layer.sql`

## Goal

Adjust the migration so it is safe to run for Phase A of the LeadBridge communication-layer integration.

The migration is close, but a few schema issues must be corrected before execution.

---

## 1) Fix `communication_webhook_events.provider_account_id`

### Problem

In `communication_provider_accounts`, the primary key is:

* `id serial PRIMARY KEY`

But in `communication_webhook_events`, the field is currently:

* `provider_account_id varchar`

This is inconsistent and misleading.

### Required change

Decide and implement one of these two options:

### Preferred option

If this field is meant to reference the SF-side provider account row, change it to:

* `provider_account_id integer REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL`

### Naming cleanup

If you still need to store the provider’s own external account identifier from LB, add a separate field:

* `external_account_id varchar`

Do **not** keep a varchar field called `provider_account_id` unless it is actually an internal FK.

---

## 2) Fix tenant scoping for uniqueness

### Problem

The migration says it supports dual scoping (`user_id` + optional `workspace_id`), but the important unique indexes are still user-scoped only.

This can cause collisions if the same user operates multiple workspaces/businesses.

### Required change

Review all uniqueness rules and make them consistent with the real tenant boundary.

### Preferred rule

If workspace/business is the real tenant boundary, update unique indexes to use:

* `workspace_id, provider, channel, ...`

and keep `user_id` only for backward compatibility / auditing.

### At minimum review these:

* `communication_provider_accounts`
* `communication_participant_identities`
* `communication_conversations`

### Example

Change:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpa_unique_account
  ON communication_provider_accounts(user_id, provider, channel, external_account_id);
```

to a workspace-aware version, such as:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpa_unique_account
  ON communication_provider_accounts(workspace_id, provider, channel, external_account_id)
  WHERE workspace_id IS NOT NULL;
```

If backward compatibility is required for rows without workspace, add a second partial unique index for the legacy `user_id`-scoped case.

The AI agent should choose a clean pattern and apply it consistently.

---

## 3) Add missing unique partial indexes for strong external identity keys

### Problem

`communication_participant_identities` currently has a unique partial index only for:

* `leadbridge_contact_id`

But these are also strong identifiers and should be protected from duplicates:

* `thumbtack_profile_id`
* `yelp_profile_id`
* `openphone_contact_id`

### Required change

Add partial unique indexes for each strong external identifier, scoped consistently with the tenant model.

### Example

If workspace-scoped:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_thumbtack_profile
  ON communication_participant_identities(workspace_id, thumbtack_profile_id)
  WHERE workspace_id IS NOT NULL AND thumbtack_profile_id IS NOT NULL;
```

Do the same for:

* `yelp_profile_id`
* `openphone_contact_id`

If legacy user-scoped fallback is needed, mirror that pattern with partial indexes for rows where `workspace_id IS NULL`.

---

## 4) Add `updated_at` maintenance

### Problem

New tables have `updated_at DEFAULT NOW()`, but nothing updates that field on row modification.

This makes `updated_at` unreliable after insert.

### Required change

Add trigger-based `updated_at` maintenance for new tables that include `updated_at`, at least:

* `communication_participant_identities`
* `communication_provider_accounts`

If the project already has a shared `set_updated_at` trigger function, reuse it.

If not, create a reusable trigger function in this migration or reference the existing standard used in the codebase.

### Expected behavior

Whenever a row is updated, `updated_at = NOW()` should be set automatically.

---

## 5) Revisit uniqueness on `communication_conversations.external_lead_id`

### Problem

The migration currently creates a unique index on:

* `(user_id, provider, channel, external_lead_id)`

This is only safe if LeadBridge guarantees exactly one conversation/thread per lead per channel.

That assumption may be too strict.

### Required change

Verify the intended LeadBridge model.

### Preferred change

Unless the LB model is guaranteed one-thread-per-lead, remove the unique index on `external_lead_id` and replace it with a normal non-unique index for lookup.

Keep the unique constraint on the actual thread/conversation identifier:

* `external_conversation_id` and/or `external_thread_id`

### Example

Replace unique index with:

```sql
CREATE INDEX IF NOT EXISTS idx_comm_conv_external_lead
  ON communication_conversations(workspace_id, provider, channel, external_lead_id)
  WHERE workspace_id IS NOT NULL AND external_lead_id IS NOT NULL;
```

If LB truly guarantees one thread per lead, keep uniqueness but add a code comment explicitly stating that assumption.

---

## 6) Normalize phone comment / semantics

### Problem

The comment for `normalized_phone` currently mixes:

* E.164
* “last 10 digits normalized”

These are different normalization strategies.

### Required change

Choose one phone-normalization standard and update the inline comment to match the actual implementation.

### Preferred standard

Use canonical E.164 where possible.

Update the comment accordingly.

---

## 7) Add `workspace_id` to `communication_webhook_events` if dual scoping remains

### Problem

The migration uses dual scoping elsewhere, but `communication_webhook_events` only has `user_id`.

### Required change

If the schema is meant to support workspace/business tenancy, add:

* `workspace_id integer REFERENCES public.sf_workspaces(id)`

Also add an index if appropriate.

This will make webhook debugging, replay, and account-level isolation consistent with the rest of the design.

---

## 8) Verify referenced columns already exist before running

### Problem

This migration creates indexes that assume existing columns are present in `communication_conversations`, including:

* `provider`
* `channel`
* `last_event_at`

### Required change

Before finalizing, verify that these columns already exist in the current schema.

If any do not exist:

* either add them in this migration
* or adjust the migration so it does not fail

Do the same check for any referenced tables:

* `public.users`
* `public.sf_workspaces`
* `public.leads`
* `public.customers`

---

## 9) Keep migration non-destructive and idempotent

### Preserve these rules

* all new columns nullable unless absolutely required
* `IF NOT EXISTS` where supported
* safe to run once in production without breaking existing communication flows

Do not refactor unrelated parts of the schema.

---

## Deliverables

1. Update `migrations/006_leadbridge_communication_layer.sql`
2. Add clear inline comments for each corrected design decision
3. Return a short summary of:

   * what changed
   * why it changed
   * any assumptions that still need confirmation before execution

---

## Acceptance Criteria

The migration is ready to run only when:

* `provider_account_id` is no longer type-mismatched
* uniqueness rules are consistent with the real tenant scope
* all strong external identity keys have duplicate protection
* `updated_at` is maintained automatically
* `external_lead_id` uniqueness is either justified explicitly or downgraded to a normal index
* webhook events support the same tenancy model as the rest of the schema
* no index references missing columns/tables


