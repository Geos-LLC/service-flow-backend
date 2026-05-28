# SF Orchestration Signing Key — Env Setup

Operator runbook for provisioning `SF_ORCH_SIGNING_KEY` (and friends) on
the Service Flow backend for the LB orchestration provisioning rollout.

**Status as of S1 / PR-C3 merge**: the credential primitives ship but no
route mounts them. The env var is **not yet required for production
operation** — but it MUST be set before S3 / PR-C5 (credential
endpoints) ships, because that's when the first endpoint can call
`mintCredential`.

## Vars

| Env var | Required when | Format | Notes |
|---|---|---|---|
| `SF_ORCH_SIGNING_KEY` | S3+ | base64-encoded **32 random bytes** | Current HMAC key. Distinct per environment. |
| `SF_ORCH_SIGNING_KEY_KID` | optional | string | Key id. Defaults to `sf_orch_2026_05`. Override only when rotating. |
| `SF_ORCH_SIGNING_KEY_PREV` | only during kid-rotation overlap | base64-encoded 32 random bytes | Previous HMAC key. Set during the window where credentials minted under the old kid are still valid. |
| `SF_ORCH_SIGNING_KEY_PREV_KID` | when `_PREV` is set | string | The kid that pairs with `SF_ORCH_SIGNING_KEY_PREV`. |

## Hard rules

1. **Distinct per environment.** Staging and prod MUST use different
   keys. A leak in staging must not compromise prod tokens.
2. **No hardcoded secrets.** Never commit the key to source. Never log
   the plaintext key. The credential primitives log only `token_prefix`
   and `cred_id` — never the full token or the signing key.
3. **Distinct from other keys.** The signing key MUST be different from:
   - `SF_INTEGRATION_ENC_KEY` (used for AES-encrypting LB webhook
     secrets and integration tokens)
   - The JWT signing key
   - Any slot-token key
   Each key serves a single purpose; a leak of one must not cascade.
4. **Domain separation is built in.** The HMAC algorithm prepends the
   constant `sf-orchestration:` before signing, so even an accidental
   reuse of another key would still produce non-overlapping tokens.
   This is defense in depth, not a substitute for key separation.
5. **Key length: at least 32 bytes (256 bits) of entropy.** Anything
   shorter is rejected at boot by the codec validation.

## Generation

Generate a fresh key with OpenSSL or Node:

```bash
# 32 random bytes, base64-encoded
openssl rand -base64 32

# or, via Node
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Example output (do NOT use this; generate your own):

```
hN3kQ9PqXxJZ4n8wRfLm7vAYbCuTzKsEi5dD2GhM6oI=
```

## Setting in Railway

```bash
# Staging
railway link --project service-flow-backend-staging --service service-flow-backend-staging
railway variables set SF_ORCH_SIGNING_KEY="<base64-32-bytes-for-staging>"
railway variables set SF_ORCH_SIGNING_KEY_KID="sf_orch_2026_05"

# Production
railway link --project service-flow-backend-production --service service-flow-backend-production
railway variables set SF_ORCH_SIGNING_KEY="<DIFFERENT-base64-32-bytes-for-prod>"
railway variables set SF_ORCH_SIGNING_KEY_KID="sf_orch_2026_05"
```

After setting, **restart the service** so the new env is picked up:

```bash
railway up --detach
# or: trigger a deploy via the Railway dashboard
```

## Verification

Once set, verify (without printing the secret) that the codec can
resolve a key for the current kid:

```bash
# On the Railway shell or via a one-off command:
node -e "
const c = require('./lib/lb-orchestration-credentials');
const key = c.resolveSigningKey(c.getCurrentKid());
if (!key) { console.error('MISSING'); process.exit(1); }
if (key.length < 32) { console.error('TOO SHORT:', key.length); process.exit(1); }
console.log('OK — kid:', c.getCurrentKid(), 'len:', key.length);
"
```

Expected output: `OK — kid: sf_orch_2026_05 len: 32`.

## Rotation (future)

When you eventually rotate the signing key (planned cadence: yearly, or
immediately on suspected compromise):

1. Generate a new key. Pick a new kid (e.g. `sf_orch_2027_01`).
2. On the backend:
   - Move the current `SF_ORCH_SIGNING_KEY` → `SF_ORCH_SIGNING_KEY_PREV`.
   - Move the current `SF_ORCH_SIGNING_KEY_KID` → `SF_ORCH_SIGNING_KEY_PREV_KID`.
   - Set `SF_ORCH_SIGNING_KEY` to the new key.
   - Set `SF_ORCH_SIGNING_KEY_KID` to the new kid.
3. Restart.
4. Existing credentials (signed under the previous kid) continue to
   verify via `SF_ORCH_SIGNING_KEY_PREV`. New credentials are signed
   under the new kid.
5. Once all credentials with the old kid have expired (≥ 90 days after
   the last mint under the old kid), unset both `_PREV` env vars.

Tokens already minted are not re-signed — they continue to verify with
the kid embedded in their payload until their natural expiry.

## What happens if the env is missing

- `mintCredential` returns `{ ok: false, reason: 'signing_key_not_configured' }`.
- `verifyCredentialToken` on any token whose payload kid doesn't match a
  configured key returns `{ valid: false, reason: 'unknown_kid' }`.
- The server does NOT crash on boot — the credential primitives are
  lazy-loaded by design.
- No tenant becomes implicitly disabled; if no credentials exist yet
  (the current state in prod), there is nothing to verify and no traffic
  to mint for. Setting the env is a prerequisite for S3, not a
  prerequisite for current operation.

## Related files

- `lib/lb-orchestration-credentials.js` — `mintCredential`, `verifyCredentialToken`, `rotateCredential`, `revokeCredential`, `sweepExpiredRotating`
- `lib/lb-orchestration-token-format.js` — `encodeToken`, `verifyTokenSignature`, `hashTokenForLookup`
- `migrations/057_orchestration_credentials.sql` — `lb_orchestration_credentials` schema
- `tests/lb-orchestration-credentials.test.js` — 39 unit tests
