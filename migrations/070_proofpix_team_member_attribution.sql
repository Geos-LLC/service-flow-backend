-- ProofPix integration — team-member attribution on pairings.
--
-- Currently a team member's SF JWT carries the workspace owner's
-- users.id, so their pair rows land under user_id = <owner's id>
-- with no way to tell WHICH team member did the pairing. This
-- migration adds a nullable team_member_id column so the settings
-- page can attribute each device to the right person.
--
--   team_member_id NULL   → paired by the account owner directly
--   team_member_id <id>   → paired by that team member (belongs to
--                           user_id's workspace via the existing
--                           team_members.user_id FK)
--
-- Column added to BOTH tables so the id can flow issue → redeem:
--   /connect/{code,token}/issue captures teamMemberId from the JWT
--   and writes it onto proofpix_connect_codes; handleRedeem copies
--   it forward when it creates the proofpix_connections row.
--
-- All existing rows keep team_member_id = NULL (attributed to owner)
-- — that's the correct interpretation of the pre-migration state,
-- since we had no way to distinguish before.
--
-- ON DELETE SET NULL: if a team member is removed from the workspace,
-- their historical pairs remain intact but lose the attribution
-- pointer (row still visible to the owner, just as "Unknown member").
--
-- Rollback: 070_proofpix_team_member_attribution_down.sql.

ALTER TABLE public.proofpix_connect_codes
  ADD COLUMN IF NOT EXISTS team_member_id INTEGER
    REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE public.proofpix_connections
  ADD COLUMN IF NOT EXISTS team_member_id INTEGER
    REFERENCES public.team_members(id) ON DELETE SET NULL;

-- Partial index — GET /connections filters WHERE team_member_id = ?
-- for the team-member scoping path (a team member sees only their
-- own devices). Excluding revoked rows keeps this index small.
CREATE INDEX IF NOT EXISTS idx_proofpix_connections_team_member_active
  ON public.proofpix_connections (team_member_id)
  WHERE revoked_at IS NULL AND team_member_id IS NOT NULL;

COMMENT ON COLUMN public.proofpix_connect_codes.team_member_id IS
  'FK to team_members.id if the code was issued while a team member was signed in. Copied forward to proofpix_connections at redeem time. NULL = issued by the workspace owner directly.';

COMMENT ON COLUMN public.proofpix_connections.team_member_id IS
  'FK to team_members.id if the paired device belongs to a team member. NULL = the workspace owner''s device. On team_members DELETE the pointer is set NULL (row survives, attribution lost).';
