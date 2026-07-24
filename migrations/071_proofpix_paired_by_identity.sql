-- ProofPix integration — capture identity of the person completing pair.
--
-- ProofPix mobile now sends `paired_by_proofpix_user_id`,
-- `paired_by_name`, and `paired_by_email` in the POST /connect/redeem
-- body (their commit ships in the next OTA — additive change, backward
-- compat with pre-cbb4bd1 clients maintained by making all fields
-- optional).
--
-- Coverage per role (from ProofPix engineer's note):
--   • admin / individual → all three present
--   • team_member        → id + name present; email is NULL (team
--                          members have no email locally on ProofPix)
--
-- SF displays the name on /settings/proofpix so the workspace admin
-- can identify each paired device by the actual person owning it,
-- distinct from the existing device_label (which is a device
-- description, not a person).
--
-- Legacy connections (pre-OTA) stay NULL on these fields — that's the
-- correct null-value semantics (we had no identity data before).
--
-- Numbering: 071 rather than reusing 070 because 070 was allocated
-- earlier to a different (reverted) feature (see git history:
-- commit 39591e9 up, 9a3dda6 revert). Keep migration numbers
-- monotonic even across reverts for a clean audit trail.
--
-- Rollback: 071_proofpix_paired_by_identity_down.sql.

ALTER TABLE public.proofpix_connections
  ADD COLUMN IF NOT EXISTS paired_by_proofpix_user_id  TEXT,
  ADD COLUMN IF NOT EXISTS paired_by_name              TEXT,
  ADD COLUMN IF NOT EXISTS paired_by_email             TEXT;

COMMENT ON COLUMN public.proofpix_connections.paired_by_proofpix_user_id IS
  'Stable identifier of the ProofPix user who completed the pair. For admins/individuals, this is their Google/Apple SSO user id. For team members, it''s the Keychain-backed sessionId ProofPix uses to identify a joined member. Opaque to SF — we only display + audit, never verify. Up to 64 chars per the integration spec.';

COMMENT ON COLUMN public.proofpix_connections.paired_by_name IS
  'Display name of the pairing person, as ProofPix knows them. Populated for admins from their Google/Apple profile; for team members from what they typed during setup. May be NULL if the team member skipped the name entry. Up to 200 chars.';

COMMENT ON COLUMN public.proofpix_connections.paired_by_email IS
  'Email of the pairing person. Populated for admin/individual accounts (from SSO). ALWAYS NULL for team_member role — team members have no email locally on the ProofPix device. Up to 200 chars.';
