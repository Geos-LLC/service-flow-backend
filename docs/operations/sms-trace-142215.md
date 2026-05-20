# SMS Forensic Trace — SF Job 142215

**Date:** 2026-05-20
**Subject:** Determine exactly why a team member received the appointment-confirmation SMS for job 142215.
**TL;DR:** SF's code path is correct — SMS was sent to `customers.phone = 7272974561`, the recipient phone tied to the job's customer record. BUT phone `7272974561` is ALSO stored on team_member 2649 (Tetiana Vasylchenko Tampa) for the same tenant. The phone is shared across two different roles. A human-perspective "team member received customer SMS" report is consistent with either (a) the customer and team-member sharing one physical device, or (b) the operator using a single device for multi-role testing. The code did not misroute; the **DATA has a cross-role phone collision** that no current guard catches. This is exactly the scenario the integrity audit was filed to surface.

---

## 1. SF job 142215 — full row

| Column | Value |
|---|---|
| `id` | 142215 |
| `user_id` | 2 ("Spotless Homes Florida LLC") |
| `customer_id` | 23468 |
| `team_member_id` | 2623 |
| `territory` | Tampa |
| `service_id` | 1852 (Deep Cleaning) |
| `scheduled_date` | 2026-05-22 13:30:00 |
| `status` | pending |
| `zenbooker_id` | null at trace-start (ZB inbound mirror will fill this from the `job.created` echo) |
| `sms_sent` | **true** ✓ (F1 fix proven) |
| `sms_phone` | `7272974561` ✓ |
| `sms_sid` | `SM0bbd62260a1d1bc5ee7be4cd4c9cdd30` ✓ |
| `confirmation_sent` | **true** ✓ |
| `confirmation_email` | null |
| `created_at` | 2026-05-20 21:52:25.479315Z |

---

## 2. Resolved source chain — every DB read before the Twilio call

The POST /api/jobs handler executed these reads in order (per [server.js:5746-5888](../../server.js#L5746-L5888)):

1. **jobs INSERT** — created row 142215. Returns `result` object including `customer_id=23468`, `service_id=1852`, `user_id=2`.

2. **customers SELECT** ([server.js:5747-5751](../../server.js#L5747-L5751)):
   ```sql
   SELECT id, first_name, last_name, email, phone
     FROM customers
    WHERE id = 23468;
   ```
   → `{id: 23468, first_name: 'test', last_name: 'customer for georgiy', email: null, phone: '7272974561'}`

3. **services SELECT** ([server.js:5755-5759](../../server.js#L5755-L5759)):
   ```sql
   SELECT name FROM services WHERE id = 1852;
   ```
   → `{name: 'Deep Cleaning '}` (note: trailing space in name preserved)

4. **users SELECT** ([server.js:5761-5765](../../server.js#L5761-L5765)):
   ```sql
   SELECT business_name FROM users WHERE id = 2;
   ```
   → `{business_name: 'Spotless Homes Florida LLC'}`

5. **customer_notification_preferences SELECT** ([server.js:5773-5777](../../server.js#L5773-L5777)):
   ```sql
   SELECT email_notifications, sms_notifications
     FROM customer_notification_preferences
    WHERE customer_id = 23468;
   ```
   → `{email_notifications: false, sms_notifications: true}` (existing row, no insert)

6. **branching** ([server.js:5874-5887](../../server.js#L5874-L5887)):
   - `hasEmail = customerData.email != null && customerData.email.trim() !== ''` → `false`
   - `hasPhone = customerData.phone != null && customerData.phone.trim() !== ''` → `true`
   - Branch selected: `else if (!hasEmail && hasPhone)` → SMS confirmation (no email)
   - Loki log: `[JobConfirmation] 📧 Notification check job=142215 hasEmail=null hasPhone=true emailNotifications=false smsNotifications=true`

7. **SMS body constructed** ([server.js:5933-5941](../../server.js#L5933-L5941)):
   ```
   Hi test customer for georgiy! Your appointment is confirmed for Deep Cleaning  on Friday, May 22 at 1:30 PM. We'll see you soon! - Spotless Homes Florida LLC
   ```
   (`body_len=156` per Loki log)

8. **sendSMSWithUserTwilio(2, '7272974561', smsMessage)** invoked ([server.js:5932](../../server.js#L5932)).

9. **users SELECT (inside helper)** ([server.js:35969-35973](../../server.js#L35969-L35973)):
   ```sql
   SELECT twilio_account_sid, twilio_auth_token, twilio_notification_phone
     FROM users
    WHERE id = 2;
   ```
   → `{twilio_account_sid: <set>, twilio_auth_token: <set>, twilio_notification_phone: '+17869050302'}`

10. **Twilio API call** ([server.js:35956](../../server.js#L35956)):
    ```js
    userTwilioClient.messages.create({
      body: smsMessage,
      from: '+17869050302',  // SF's twilio_notification_phone for user 2
      to: '7272974561'       // customer 23468's phone
    });
    ```
    Returns: `{sid: 'SM0bbd62260a1d1bc5ee7be4cd4c9cdd30', ...}`

11. **persistConfirmationStatus** (F1 fix) ([server.js:5947-5958](../../server.js#L5947-L5958)):
    ```sql
    UPDATE jobs SET
      confirmation_sent = true,
      confirmation_sent_at = '2026-05-20T21:52:26Z',
      sms_sent = true,
      sms_sent_at = '2026-05-20T21:52:26Z',
      sms_phone = '7272974561',
      sms_sid = 'SM0bbd62260a1d1bc5ee7be4cd4c9cdd30',
      sms_failed = false,
      sms_error = null
    WHERE id = 142215;
    ```
    → no error. Loki: `[JobConfirmation] update ok job=142215 context=sms_no_email_success`.

---

## 3. Recipient determination

| Aspect | Value |
|---|---|
| **Code-resolved recipient** | `customerData.phone` from `customers.id=23468` = `7272974561` |
| **Twilio FROM** | `users.twilio_notification_phone` for `users.id=2` = `+17869050302` |
| **Intent class** | CUSTOMER-FACING (this is the customer's appointment confirmation, body uses `customerName`) |
| **Resolution mode** | DB-resolved (customer) |
| **Fallback chain depth** | 0 (no fallback used) |
| **Cross-tenant risk** | None (all reads scoped by `user_id=2` or by `customers.id` which is unique) |

**The code correctly resolved a CUSTOMER-FACING recipient from `customers.phone`. No team_member phone was queried by this code path.**

---

## 4. WHY a team member received the message

The team_member assigned to job 142215 is `team_members.id=2623` ("Georgiy Team Member") with phone `2483462681`. That phone was NEVER queried by this code path; the SMS was NOT sent to `2483462681`.

The SMS was sent to `7272974561` — the customer's phone.

**Cross-role phone collision check** (executed during this audit):

```sql
SELECT phone,
       (SELECT count(*) FROM customers   WHERE user_id=2 AND phone=t.phone) AS customer_count,
       (SELECT count(*) FROM team_members WHERE user_id=2 AND phone=t.phone) AS team_count
  FROM (VALUES ('7272974561'), ('2483462681')) AS t(phone);
```

| phone | customer_count | team_count | Identification |
|---|---|---|---|
| `7272974561` | 1 | 1 | customer 23468 ("test customer for georgiy") + team_member **2649** ("Tetiana Vasylchenko Tampa") |
| `2483462681` | 3 | 1 | THREE customers + team_member 2623 ("Georgiy Team Member") |

**Conclusion:** phone `7272974561` is owned (in SF data) by both customer 23468 AND team_member 2649. When SF correctly sent the SMS to "the customer's phone," that phone is ALSO listed against a team member's record. From a code-path perspective, the message went to the customer. From a human perspective, the SMS may have landed on a device whose owner is registered as a team member.

This is **the exact failure mode the audit was designed to surface**: a customer-facing path can land on a phone that is ALSO a team-member phone, because SF currently does NOT enforce uniqueness or role-exclusivity on phone numbers within a tenant.

---

## 5. Two interpretations — both valid

### Interpretation A — "Operator multi-role testing"

The operator (Georgiy, user_id=2) is running a pilot test. The customer 23468 is named "test customer for georgiy". The operator uses a single physical phone for multiple roles in testing. The SMS arrives on the operator's phone; the operator interprets receipt-in-team-member-role as "a team member got the SMS." No data error; intentional testing setup.

**Evidence for:** customer is explicitly named "test customer for georgiy"; the operator created it. Plausible.

### Interpretation B — "Data integrity violation"

Two distinct humans (customer 23468 and team_member 2649 Tetiana) genuinely share the same phone number `7272974561`. When SF sends customer confirmations, they ALSO reach a registered team member. This is real data leakage — Tetiana is receiving SMS not intended for her.

**Evidence for:** team_member 2649 has email `tanyami1983@gmail.com` (clearly a real person, not a test fixture); the phone is also stored on customer 23468 with a different name.

### Either way

Both interpretations expose the SAME structural risk: **SF has no integrity guard preventing a customer-facing SMS from landing on a phone that is also a team_member phone.** Building that guard is the right move regardless of which interpretation is correct for this specific incident.

---

## 6. What the [RecipientIntegrityViolation] guard would do for this case

A customer-facing send to `7272974561` would trigger the proposed integrity check:

```
intent = CUSTOMER-FACING
resolved_phone = 7272974561
customer-side count for user_id=2 = 1
team-member-side count for user_id=2 = 1   ← non-zero → ambiguous
```

Two possible policies (TBD with operator):

| Policy | Behavior |
|---|---|
| **STRICT** | Block the send. Emit `[RecipientIntegrityViolation]`. Operator must reconcile data (set unique phones) before SMS fires. |
| **WARN** | Send the SMS but emit `[RecipientIntegrityViolation]` log line with `severity=warn` so the audit trail surfaces the ambiguity for later review. |

My recommendation: **WARN mode for Phase B** (don't block customer communications on data ambiguity), **STRICT mode candidacy in Phase C** after operator has had time to deduplicate phones.

---

## 7. Bonus finding — `2483462681` (the team_member's phone) is ALSO a customer phone × 3

Three customers in user_id=2 have phone `2483462681` (the same as team_member 2623 "Georgiy Team Member"). So if any of those three customers had SMS notifications enabled with no email, SF would correctly send a confirmation to `2483462681`, and the human at that phone is also a registered cleaner. Same class of risk.

Operator-action recommendation: review and dedupe phone numbers within user_id=2's customer and team_member rosters. The audit cannot tell which records are legitimate distinct humans vs. test fixtures, but the operator can.

---

## 8. Code-path verdict

**The SF code path correctly resolved the customer's phone. There is no SF code bug in the recipient resolution for job 142215.** The team-member receipt of a customer-intended SMS, if not a multi-role testing artifact, is a downstream consequence of cross-role data collision that no SF guard currently catches.

---

## 9. Cross-reference

- [recipient_source_map.md](./recipient_source_map.md) — full SMS path inventory
- [phase-b-readiness-v3.md](../architecture/phase-b-readiness-v3.md) — phase context
- The job 142215 trace itself confirms F1 ✓ (sms_sent persisted) + F2 ✓ (no ERR_HTTP_HEADERS_SENT) + F3 ✓ (Loki contains `[JobConfirmation]` logs)

---

## 10. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-20 | 0.1 | Initial trace. Code path verified correct. Cross-role phone collisions surfaced (`7272974561` and `2483462681` both registered on customer AND team_member records). Integrity guard rationale documented. |
