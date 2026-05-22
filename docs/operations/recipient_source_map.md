# SMS Recipient Source Map — Audit Artifact

**Date:** 2026-05-20
**Trigger:** P0 — Notification Recipient Integrity Audit. A team member reported receiving an SMS with customer-greeting content. Investigation showed the SMS was correctly routed (SF sent to `customers.phone = 7272974561`; operator's physical phone matched), but the report exposed a class of risk: there is currently NO systemic guard preventing a customer-facing path from accidentally resolving a team-member phone (or vice versa). This audit catalogs every SMS path so the integrity guard can be implemented uniformly.
**Method:** Static analysis of `server.js`, `twilio-connect-setup.js`, all `workers/`, all `lib/`, `notification-email.service.js`, `push.service.js`, and tests. Cross-referenced with Loki log patterns. No production reads of customer/team_member rows other than the existing 142215 forensic trace (Objective 2).
**Scope:** SMS only. Email confirmation goes through `notification-email.service.js` and is out of scope. WhatsApp/OpenPhone messaging IS in scope (reply-channel paths can also misroute).

---

## 0. Path classification taxonomy

Each path has an **intent class** (who is this message designed to reach?) and a **recipient resolution mode** (where does the phone number come from?).

| Intent class | Definition |
|---|---|
| **CUSTOMER-FACING** | Recipient must be the customer associated with a job, invoice, or estimate. Examples: appointment confirmation, payment reminder, status update. |
| **CLEANER-FACING** | Recipient must be a team member. Examples: assignment notification, schedule reminder. SF does NOT currently have a cleaner-facing SMS path (notifications to cleaners go via email through `job-notifications.service.js`). |
| **EXTERNAL/CALLER-SUPPLIED** | Recipient is whatever the API caller passes. The integrity gate cannot enforce intent here — caller responsibility. Examples: `/api/sms/send`, `/api/twilio/send-sms`. |
| **CONVERSATION-REPLY** | Recipient is the other party in an existing conversation thread. Intent is "reply to whoever messaged us." Examples: OpenPhone reply, WhatsApp reply. |
| **SYSTEM-TEST** | Recipient is the operator's own test phone. Example: `/api/twilio/test-sms`. |

| Recipient resolution mode | Definition |
|---|---|
| **DB-resolved (customer)** | Recipient pulled from `customers.phone` after a DB lookup tied to a job/customer entity. |
| **DB-resolved (team_member)** | Recipient pulled from `team_members.phone`. |
| **DB-resolved (user/owner)** | Recipient pulled from `users.phone` or `users.twilio_notification_phone`. |
| **Caller-supplied** | Recipient passed in via request body / function argument; no DB lookup. |
| **Conversation-derived** | Recipient pulled from `communication_conversations.participant_phone`. |

---

## 1. Complete SMS path inventory

### 1.1 Path P-01 — Job creation confirmation SMS (no-email branch)

| Field | Value |
|---|---|
| Trigger | `POST /api/jobs` → customer has phone but NO email |
| Send function | `sendSMSWithUserTwilio(userId, to, message)` |
| Caller line | [server.js:5932](../../server.js#L5932) |
| Recipient source | `customerData.phone` after `SELECT id, first_name, last_name, email, phone FROM customers WHERE id=<result.customer_id>` ([server.js:5746-5751](../../server.js#L5746-L5751)) |
| Fallback chain | NONE — if `customerData.phone` is null, branch doesn't enter (`hasPhone` gate at line 5874) |
| Tenant scope | `req.user.userId` → `users.twilio_account_sid/auth_token/notification_phone` |
| Cache usage | None |
| Logging (post-F3) | `[JobConfirmation]` structured logger ✓ |
| F1-checked update | ✓ via `persistConfirmationStatus` |
| Intent class | **CUSTOMER-FACING** |
| Resolution mode | **DB-resolved (customer)** |
| Audit risk | LOW — single field, no fallback, clearly customer-scoped |

### 1.2 Path P-02 — Job creation also-SMS (when customer also has email)

| Field | Value |
|---|---|
| Trigger | `POST /api/jobs` → customer has email AND phone, and `customer_notification_preferences.sms_notifications=true` |
| Send function | `sendSMSWithUserTwilio(userId, to, message)` |
| Caller line | [server.js:5981](../../server.js#L5981) |
| Recipient source | `customerData.phone` (same DB read as P-01) |
| Fallback chain | NONE |
| Tenant scope | `req.user.userId` |
| Cache usage | None |
| Logging (post-F3) | `[JobConfirmation]` structured logger ✓ |
| F1-checked update | ✓ |
| Intent class | **CUSTOMER-FACING** |
| Resolution mode | **DB-resolved (customer)** |
| Audit risk | LOW |

### 1.3 Path P-03 — Job status change SMS (PATCH /api/jobs/:id/status)

| Field | Value |
|---|---|
| Trigger | `PATCH /api/jobs/:id/status` → status flips to `confirmed`, `completed`, or `cancelled` |
| Send function | `sendSMSWithUserTwilio(userId, to, message)` |
| Caller line | [server.js:6594](../../server.js#L6594) |
| Recipient source | `jobData.customers.phone` from `SELECT jobs.*, customers!inner(...) WHERE jobs.id=<:id>` ([server.js: status handler]) |
| Fallback chain | NONE — branch gated by `jobData.customers.phone` truthy |
| Tenant scope | `req.user.userId` |
| Cache usage | None |
| Logging (current) | `console.log` — **NOT visible in Loki** (audit F3-style gap) |
| F1-checked update | ✗ — uses inline `supabase.from('jobs').update(...)` without error checking ([server.js:6602-6612](../../server.js#L6602-L6612)) |
| Intent class | **CUSTOMER-FACING** |
| Resolution mode | **DB-resolved (customer)** |
| Audit risk | MEDIUM — has the same `confirmation_method`-style silent-failure surface that F1 fixed elsewhere; logging gap |

### 1.4 Path P-04 — `sendSMSWithUserTwilio` helper

| Field | Value |
|---|---|
| Definition | [server.js:35940](../../server.js#L35940) |
| Recipient source | `to` parameter — caller-supplied |
| Twilio FROM | `userData.twilio_notification_phone` (user/owner's outbound SMS number, lookup by `userId`) |
| Tenant scope | `userId` parameter |
| Logging (current) | `console.log('📱 SMS sent via user Twilio credentials:', result.sid)` — **NOT visible in Loki** |
| Intent class | (helper — inherits from caller) |
| Resolution mode | Caller-supplied |
| Audit risk | This is the choke point. **All inline SMS sends should go through this helper.** Adding integrity instrumentation here covers P-01, P-02, P-03 simultaneously. |

### 1.5 Path P-05 — `POST /api/sms/send-connect` (Twilio Connect arbitrary send)

| Field | Value |
|---|---|
| Route | `app.post('/api/sms/send-connect')` |
| Caller line | [server.js:35255](../../server.js#L35255) |
| Recipient source | `req.body.to` — caller-supplied |
| Twilio FROM | `userData.twilio_notification_phone` |
| Tenant scope | `req.user.userId` |
| Cache usage | None |
| Logging (current) | `console.log('📱 SMS sent via Twilio Connect:', result.sid)` |
| Intent class | **EXTERNAL/CALLER-SUPPLIED** |
| Resolution mode | Caller-supplied |
| Audit risk | MEDIUM — auth-gated but recipient comes from the request body. Caller (typically the SF UI's "Send Test" or admin tools) is responsible for picking the right number. The integrity gate CANNOT enforce intent here because the path doesn't know what kind of message it's sending. Recommend: emit `[NotificationRecipient]` log line so out-of-band reviews can verify recipients post-hoc. |

### 1.6 Path P-06 — `POST /api/twilio/send-sms` (direct Twilio arbitrary send)

| Field | Value |
|---|---|
| Route | `app.post('/api/twilio/send-sms')` |
| Caller line | [server.js:35781](../../server.js#L35781) |
| Recipient source | `req.body.to` — caller-supplied |
| Twilio FROM | `userData[0].twilio_notification_phone` |
| Tenant scope | `req.user.userId` |
| Intent class | **EXTERNAL/CALLER-SUPPLIED** |
| Resolution mode | Caller-supplied |
| Audit risk | Same as P-05 |

### 1.7 Path P-07 — `POST /api/twilio/test-sms` (test SMS)

| Field | Value |
|---|---|
| Route | `app.post('/api/twilio/test-sms')` |
| Caller line | [server.js:35817](../../server.js#L35817) |
| Recipient source | `req.body.phoneNumber` — caller-supplied |
| Twilio FROM | `userData[0].twilio_notification_phone` |
| Tenant scope | `req.user.userId` |
| Body | Hardcoded test string (no PII / no customer data) |
| Intent class | **SYSTEM-TEST** |
| Resolution mode | Caller-supplied |
| Audit risk | LOW — fixed test message, no PII, operator self-service. |

### 1.8 Path P-08 — `POST /api/sms/send` (global-twilio fallback)

| Field | Value |
|---|---|
| Route | `app.post('/api/sms/send')` |
| Caller line | [server.js:35980](../../server.js#L35980) |
| Recipient source | `req.body.to` — caller-supplied |
| Twilio FROM | `TWILIO_PHONE_NUMBER` (env var; platform-owned, NOT per-tenant) |
| Tenant scope | `req.user.userId` (auth) but FROM number is global |
| Intent class | **EXTERNAL/CALLER-SUPPLIED** |
| Resolution mode | Caller-supplied |
| Audit risk | HIGH — sends from the platform-global Twilio number, bypassing per-tenant Twilio configuration. **Likely dead code or legacy** (post-Twilio-Connect migration). Recommend: deprecate and remove. |

### 1.9 Path P-09 — `POST /api/sms/job-confirmation` (legacy global-twilio job confirmation)

| Field | Value |
|---|---|
| Route | `app.post('/api/sms/job-confirmation')` |
| Caller line | [server.js:36011](../../server.js#L36011) |
| Recipient source | `req.body.customerPhone` — caller-supplied |
| Twilio FROM | `TWILIO_PHONE_NUMBER` (platform-global) |
| Tenant scope | `req.user.userId` (auth) but FROM is global |
| Body | Templated: `Hi ${customerName}! Your booking is confirmed for...` |
| Intent class | **CUSTOMER-FACING** (per body template) |
| Resolution mode | Caller-supplied (declared by callsite) |
| Audit risk | HIGH — claims customer-intent in the body BUT trusts the caller to supply the right `customerPhone`. No server-side verification that `customerPhone` matches a real customer. **Likely dead code** since the inline confirmation flow at P-01/P-02 superseded this. Recommend: deprecate or add server-side recipient validation. |

### 1.10 Path P-10 — `POST /api/sms/payment-reminder` (legacy global-twilio payment reminder)

| Field | Value |
|---|---|
| Route | `app.post('/api/sms/payment-reminder')` |
| Caller line | [server.js:36042](../../server.js#L36042) |
| Recipient source | `req.body.customerPhone` — caller-supplied |
| Twilio FROM | `TWILIO_PHONE_NUMBER` (platform-global) |
| Intent class | **CUSTOMER-FACING** (per body template) |
| Resolution mode | Caller-supplied |
| Audit risk | Same as P-09 — caller responsibility, no server-side recipient validation. |

### 1.11 Path P-11 — `twilio-connect-setup.js` (Twilio Connect setup test SMS)

| Field | Value |
|---|---|
| Endpoint | (mounted under `/api/twilio-connect/` per file location) |
| Caller line | [twilio-connect-setup.js:136](../../twilio-connect-setup.js#L136) |
| Recipient source | `req.body.to` — caller-supplied |
| Twilio FROM | `userData.twilio_phone_number` |
| Tenant scope | `userId` from auth |
| Intent class | **SYSTEM-TEST** / **EXTERNAL** |
| Resolution mode | Caller-supplied |
| Audit risk | LOW — setup-time test path. Recommend: emit `[NotificationRecipient]` log line for completeness. |

### 1.12 Path P-12 — Sigcore OpenPhone conversation reply

| Field | Value |
|---|---|
| Route | `POST /api/conversations/:id/messages` (OpenPhone branch) |
| Caller line | [server.js:42216](../../server.js#L42216) / [server.js:42223](../../server.js#L42223) |
| Send function | `sigcoreRequest('POST', '/messages' OR '/internal/messages/send', ...)` |
| Recipient source | `conv.participant_phone` from `communication_conversations` table — the other party in the existing thread |
| Tenant scope | `userId` from auth → `getSigcoreSettings(userId)` |
| Cache usage | `settings.cached_phone_numbers` (the sender's phone numbers cached locally) |
| Logging | `logger.error` on failure only; success path doesn't log |
| Intent class | **CONVERSATION-REPLY** |
| Resolution mode | **Conversation-derived** |
| Audit risk | LOW — recipient is whoever the operator is replying to in a UI thread. The participant_phone IS the intended recipient by definition. But the path does NOT verify that `conv.user_id == req.user.userId` for tenant safety — **separate audit item**: tenant isolation for conversation send. |

### 1.13 Path P-13 — Sigcore WhatsApp conversation reply

| Field | Value |
|---|---|
| Caller line | [server.js:42171](../../server.js#L42171) |
| Send function | `sigcoreRequest('POST', '/integrations/whatsapp/send', ...)` |
| Recipient source | `conv.participant_phone` |
| Tenant scope | `userId` |
| Intent class | **CONVERSATION-REPLY** |
| Resolution mode | **Conversation-derived** |
| Audit risk | Same as P-12 |

### 1.14 Path P-14 — ZB outbound producer (NOT an SMS path)

For completeness: the ZB outbound producer at [lib/zb-outbound-producer.js](../../lib/zb-outbound-producer.js) sends commands to ZB's API. ZB's downstream notification system MAY send SMS, but per the 2026-05-20 fix (`sms_notifications: false`, `email_notifications: false`), SF explicitly suppresses ZB-side notifications on every outbound `job.create`. ZB notifications are out of SF's recipient-integrity scope; SF's responsibility is the suppression flag.

### 1.15 Path P-15 — Cron jobs

Inventory:
- `cron.schedule('0 9 * * *', ...)` at [server.js:398](../../server.js#L398) — recurring billing. Creates new jobs internally; does NOT send SMS directly. New-job SMS flows through P-01/P-02 (via the standard job-create code path — but **note:** the cron's internal call may NOT go through the actual `POST /api/jobs` HTTP route; it likely INSERTs directly. **Audit gap:** if it inserts without invoking the SMS pipeline, customers may miss confirmations on recurring renewals. Cross-check: confirm whether recurring billing cron triggers SMS or not.
- `cron.schedule('0 7 * * *', ...)` at [server.js:546](../../server.js#L546) — auto-payout batch. Does NOT send SMS.

### 1.16 Path P-16 — ZB→SF inbound webhook handlers

Inbound webhooks from ZB do NOT send SMS. They UPDATE SF rows. If ZB-side notifications fire (the 2026-05-20 scenario), they go from ZB → recipient directly, not through SF.

### 1.17 Background workers

- `workers/leadbridge-outbound-drainer.js` — does NOT send SMS. Sends to LeadBridge API.
- `workers/zb-outbound-drainer.js` — does NOT send SMS. Sends to ZB API.

No worker currently sends SMS.

---

## 2. Summary table

| # | Path | Intent | Recipient source | Tenant scope | Loki visibility | Risk |
|---|---|---|---|---|---|---|
| P-01 | POST /api/jobs no-email-SMS | customer | `customers.phone` | userId | ✓ (F3) | LOW |
| P-02 | POST /api/jobs also-SMS | customer | `customers.phone` | userId | ✓ (F3) | LOW |
| P-03 | PATCH /api/jobs/:id/status | customer | `jobs.customers.phone` | userId | ✗ | MEDIUM |
| P-04 | sendSMSWithUserTwilio helper | (passthrough) | caller-supplied | userId | ✗ | (choke point) |
| P-05 | POST /api/sms/send-connect | external | caller body | userId | ✗ | MEDIUM |
| P-06 | POST /api/twilio/send-sms | external | caller body | userId | ✗ | MEDIUM |
| P-07 | POST /api/twilio/test-sms | test | caller body | userId | ✗ | LOW |
| P-08 | POST /api/sms/send | external (global) | caller body | global FROM | ✗ | HIGH (legacy) |
| P-09 | POST /api/sms/job-confirmation | customer (global) | caller body | global FROM | ✗ | HIGH (legacy) |
| P-10 | POST /api/sms/payment-reminder | customer (global) | caller body | global FROM | ✗ | HIGH (legacy) |
| P-11 | twilio-connect-setup test | test | caller body | userId | ✗ | LOW |
| P-12 | OpenPhone conv reply | reply | `conv.participant_phone` | userId | partial | LOW (separate tenant audit) |
| P-13 | WhatsApp conv reply | reply | `conv.participant_phone` | userId | partial | LOW (separate tenant audit) |

---

## 3. Fallback chains — confirmed inventory

Searched explicitly for `customer.phone || teamMember.phone`, `phone || ... .phone`, ternary fallbacks, and conditional recipient pickers. Result: **NONE FOUND.** Every path uses exactly one recipient field with no fallback to another role.

This means the original concern ("customer → team member → owner fallback") is NOT present in code. Today's risk is different: a caller could pass the wrong number to one of the EXTERNAL paths (P-05 to P-11), or a future refactor could introduce a fallback.

---

## 4. Cache usage — confirmed inventory

| Cache | Purpose | Risk |
|---|---|---|
| `settings.cached_phone_numbers` (P-12/P-13) | Cached list of the OPERATOR's outbound phone numbers (sender selection) | Affects FROM, not TO. No recipient-integrity risk. |
| `customer_notification_preferences` insert-on-miss | Per-customer prefs cache | Affects branching (whether SMS fires), not recipient address. |
| Producer `cached.value` for platform_settings.zb_outbound_job_create_enabled | Per-tenant opt-in cache | Affects whether outbound queue fires; not SMS recipient. |
| `users.twilio_*` columns | Per-user Twilio credentials | Affects FROM/auth, not TO. |

**No cache currently stores customer/team_member phone numbers in a way that could go stale and misroute.** Recipient phones are always fetched live from `customers.phone` / `jobs.customers.phone` / `conv.participant_phone` at send time.

---

## 5. Tenant scope — confirmed inventory

Every authenticated SMS path scopes Twilio credentials by `req.user.userId`. Two risks remain:

1. **P-12/P-13 (conversation reply)** — does NOT verify that `conv.user_id == req.user.userId` before sending. A user with a leaked conversation id could theoretically reply on behalf of another tenant. (Separate audit item — tenant-isolation for messaging. NOT a recipient-integrity issue per se.)
2. **P-08/P-09/P-10 (global TWILIO_*)** — uses platform-wide FROM. If multiple tenants share the platform's Twilio number, recipients can't easily attribute SMS to a specific business. Deprecation candidate.

---

## 6. Recommendations (informing Objectives 3, 4, 5)

### 6.1 Centralize SMS sending behind a single instrumented function

Currently P-01/P-02/P-03 funnel through `sendSMSWithUserTwilio` (good). P-05–P-11 each have their own inline Twilio call (bad — 6 separate logging gaps, 6 separate places to add integrity checks).

**Action:** Introduce `lib/sms-sender.js` exporting `sendSMS(supabase, logger, opts)` where `opts = { userId, intent, recipient, recipient_source, customer_id?, team_member_id?, job_id?, body, twilio_from? }`. Refactor every path to use it. Single place to add Loki logging, integrity assertions, and tests.

### 6.2 Emit `[NotificationRecipient]` on every send

Every SMS send (regardless of path) MUST emit a structured log line BEFORE the Twilio call:

```
[NotificationRecipient] message_type=job_confirmation_no_email_sms resolved_phone=***61 source=customers.phone fallback_depth=0 customer_id=23468 team_member_id=null job_id=142215 workspace_id=2 twilio_sid=null path=P-01
```

And AFTER, on success/failure:
```
[NotificationRecipient] message_type=... twilio_sid=SM... result=success
[NotificationRecipient] message_type=... twilio_sid=null result=failure error=...
```

### 6.3 Hard assertions for intent vs recipient source

Per Objective 4:
- CUSTOMER-FACING path MUST NOT have `recipient` matching any `team_members.phone` for the same tenant. If it does → `[RecipientIntegrityViolation]` + abort send.
- CLEANER-FACING path MUST NOT have `recipient` matching any `customers.phone` for the same tenant. (SF has no cleaner-facing SMS path today; future-proof.)
- Implementation: in the centralized helper, query the OTHER role for the resolved phone after stripping to digits. If match → assert violation.

Cost: 1 extra DB roundtrip per SMS. For Phase-B volume (<100/day) this is negligible.

### 6.4 Deprecate P-08/P-09/P-10

The three global-`TWILIO_PHONE_NUMBER` paths (`/api/sms/send`, `/api/sms/job-confirmation`, `/api/sms/payment-reminder`) appear to be legacy. Confirm whether any UI / external integration still calls them; if not, remove. If so, migrate to `sendSMSWithUserTwilio` so all traffic flows through the tenant-scoped helper.

### 6.5 Backfill F1+F3 to PATCH /api/jobs/:id/status (P-03)

The status-change SMS path has the same `console.log` + unchecked `supabase.update` pattern that F1/F3 fixed in POST /api/jobs. Apply the same `persistConfirmationStatus` + `logger.X` treatment to P-03 to bring observability to parity.

---

## 7. Open audit items (not blocking)

| # | Item | Type |
|---|---|---|
| AI-1 | Conversation send (P-12/P-13) does not verify `conv.user_id == req.user.userId` | Tenant isolation |
| AI-2 | Recurring billing cron may create jobs without invoking SMS pipeline | Notification coverage |
| AI-3 | Global-TWILIO paths (P-08/P-09/P-10) appear dead but uncertain — audit UI/external callers | Code hygiene / dead code |
| AI-4 | Cleaner-facing SMS path doesn't exist yet — future expansion needs integrity guard from day 1 | Future-proofing |

---

## 8. Coverage check

Per the original ask: "Audit: job confirmation SMS / customer notifications / cleaner notifications / payroll notifications / reminders / reschedule messages / cancellation messages / Twilio direct sends / workflow automations / LeadBridge/Sigcore bridges / fallback notification utilities / background workers / delayed jobs / cron jobs."

| Category | Coverage |
|---|---|
| job confirmation SMS | ✓ P-01, P-02, P-09 |
| customer notifications | ✓ P-01, P-02, P-03 |
| cleaner notifications | N/A — none exist today (email-only via `job-notifications.service.js`) |
| payroll notifications | N/A — payroll system does NOT send SMS today |
| reminders | ✓ P-10 (payment reminder) — appointment reminders don't exist as a separate path today (the confirmation IS the reminder) |
| reschedule messages | N/A as a separate path — reschedule rolls into the status-change path P-03 if the status is updated; otherwise no SMS fires |
| cancellation messages | ✓ P-03 (when status flips to `cancelled`) |
| Twilio direct sends | ✓ P-05, P-06, P-07, P-08 |
| workflow automations | None found — SF has no separate "workflow engine" sending SMS |
| LeadBridge bridges | ✓ via conversation P-12 (LeadBridge messages flow through the conversation API) |
| Sigcore bridges | ✓ P-12, P-13 |
| fallback notification utilities | ✓ Investigated — NONE exist |
| background workers | ✓ Confirmed: no worker sends SMS |
| delayed jobs | N/A — no delayed job queue for SMS |
| cron jobs | ✓ P-15 — neither cron sends SMS directly |

**Total SMS paths: 13.** Of these, 5 are customer-facing (P-01, P-02, P-03, P-09, P-10), 0 are cleaner-facing, 4 are external/test (P-05, P-06, P-07, P-11), 1 is global-Twilio external (P-08), 2 are conversation-reply (P-12, P-13).

---

## 9. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-20 | 0.1 | Initial audit. 13 SMS paths enumerated. NO inter-role fallback chains exist in code. NO caches store recipient phones. Three legacy global-Twilio paths (P-08/P-09/P-10) flagged for deprecation audit. Recommendations queued for Objectives 3-5. |
