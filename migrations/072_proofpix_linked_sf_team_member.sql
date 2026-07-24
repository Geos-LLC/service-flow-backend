-- ProofPix integration — device ↔ SF team_member assignment.
--
-- Distinct from the earlier attempt (migration 070, reverted): that
-- one attributed pairs to "the SF user who was signed in at pair
-- time" which was almost always the admin — attribution with no
-- meaning. THIS column is set by the admin at pair time to bind the
-- device to a SPECIFIC SF team member — meaningful and load-bearing
-- because the /jobs endpoint filters against it so each team member
-- only sees their own assigned jobs.
--
-- Semantics:
--   linked_sf_team_member_id NULL  → device belongs to the admin,
--                                    /jobs returns all workspace jobs
--   linked_sf_team_member_id <id>  → device belongs to that team
--                                    member, /jobs filters to their
--                                    assignments (via jobs.team_member_id
--                                    OR job_team_assignments)
--
-- Column added to BOTH tables so the id can flow issue → redeem:
-- /connect/{code,token}/issue captures for_team_member_id from the
-- SF admin's pair request and writes it onto proofpix_connect_codes;
-- handleRedeem copies it forward when creating the proofpix_connections
-- row.
--
-- Existing rows keep linked_sf_team_member_id NULL — correct
-- interpretation of pre-migration pairs (they were never scoped to
-- anyone, so admin-wide is right).
--
-- ON DELETE SET NULL: if a team member is removed from the workspace,
-- the device connection survives but stops being scoped to that
-- (now-gone) member. Row becomes admin-wide from that point on. If
-- that's not the desired policy we can change it to CASCADE later.
--
-- Rollback: 072_proofpix_linked_sf_team_member_down.sql.

ALTER TABLE public.proofpix_connect_codes
  ADD COLUMN IF NOT EXISTS linked_sf_team_member_id INTEGER
    REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE public.proofpix_connections
  ADD COLUMN IF NOT EXISTS linked_sf_team_member_id INTEGER
    REFERENCES public.team_members(id) ON DELETE SET NULL;

-- Covers the read path: /connections joins to team_members and /jobs
-- filters by this column via the linked connection. Small partial
-- index — active rows only, no need to index revoked history.
CREATE INDEX IF NOT EXISTS idx_proofpix_connections_linked_team_member_active
  ON public.proofpix_connections (linked_sf_team_member_id)
  WHERE revoked_at IS NULL AND linked_sf_team_member_id IS NOT NULL;

COMMENT ON COLUMN public.proofpix_connect_codes.linked_sf_team_member_id IS
  'The SF team_member this pair token is being minted FOR (chosen by the admin in the SF settings UI at connect time). NULL = the admin''s own device. Copied forward to proofpix_connections at redeem time.';

COMMENT ON COLUMN public.proofpix_connections.linked_sf_team_member_id IS
  'The SF team_member this device is assigned to. Drives the /jobs endpoint''s filter — a device linked to team_member 42 only sees jobs where jobs.team_member_id = 42 OR jobs.id IN (SELECT job_id FROM job_team_assignments WHERE team_member_id = 42). NULL = admin-wide (no filter).';
