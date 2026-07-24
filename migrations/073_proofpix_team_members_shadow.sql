-- ProofPix integration — shadow table for ProofPix-side team members.
--
-- Distinct from public.team_members (SF's own workers): those are SF's
-- internal team model. THIS table tracks members of the ProofPix
-- admin's own ProofPix team — populated when the ProofPix proxy pings
-- SF at join time via POST /api/integrations/proofpix/team-members.
--
-- Answers "who's on this admin's ProofPix crew, independent of any
-- paired device": prior to this table SF only knew about the admin
-- (via proofpix_connections) and had to wait for a photo upload with
-- `captured_by` metadata before it could infer other crew existence.
--
-- Key identity is proofpix_member_token — an opaque invite/session
-- token minted by the ProofPix proxy, stable per member. Unique
-- within a workspace so upserts key on (user_id, proofpix_member_token).
--
-- Naming note: doc SERVICE_FLOW_TEAM_MEMBERS_TASK.md uses
-- "workspace_id TEXT". SF's other tables reference users(id) as an
-- INTEGER FK, so we keep user_id INTEGER here for referential
-- integrity and stringify to workspace_id in API responses (matches
-- /connection/status's existing shape).
--
-- Rollback: 073_proofpix_team_members_shadow_down.sql.

CREATE TABLE IF NOT EXISTS public.proofpix_team_members (
  id                     BIGSERIAL    PRIMARY KEY,
  user_id                INTEGER      NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  proofpix_member_token  TEXT         NOT NULL,
  display_name           TEXT,
  email                  TEXT,
  device_model           TEXT,
  os_name                TEXT,
  os_version             TEXT,
  status                 TEXT         NOT NULL DEFAULT 'joined',
  joined_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at           TIMESTAMPTZ,
  last_upload_at         TIMESTAMPTZ,
  photo_count            INTEGER      NOT NULL DEFAULT 0,
  revoked_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT proofpix_team_members_status_ck
    CHECK (status IN ('joined', 'revoked'))
);

-- Upsert target — (workspace, token) uniqueness. ProofPix proxy hits
-- POST /team-members with the same token on every rejoin / retry;
-- this constraint makes that idempotent instead of duplicating rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proofpix_team_members_workspace_token
  ON public.proofpix_team_members (user_id, proofpix_member_token);

-- Covers GET /team-members?status=… listing per workspace.
CREATE INDEX IF NOT EXISTS idx_proofpix_team_members_workspace_status
  ON public.proofpix_team_members (user_id, status);

-- Covers the display_name lookup that /jobs/:jobId/photos runs to
-- match metadata.captured_by → shadow row for the activity bump.
CREATE INDEX IF NOT EXISTS idx_proofpix_team_members_workspace_display_name
  ON public.proofpix_team_members (user_id, display_name)
  WHERE display_name IS NOT NULL AND status = 'joined';

COMMENT ON TABLE public.proofpix_team_members IS
  'Shadow rows for ProofPix-side team members. Populated by the ProofPix proxy at POST /api/integrations/proofpix/team-members when a member joins the admin''s ProofPix session. NOT the same as public.team_members (SF workers).';

COMMENT ON COLUMN public.proofpix_team_members.proofpix_member_token IS
  'Opaque invite/session token minted by the ProofPix proxy, stable per member. Unique within a workspace — upsert target.';

COMMENT ON COLUMN public.proofpix_team_members.display_name IS
  'Name the ProofPix member registered with (or was assigned) on the ProofPix side. Nullable on first join, may be filled in later. /jobs/:jobId/photos matches captured_by against this for the activity bump.';

COMMENT ON COLUMN public.proofpix_team_members.status IS
  'joined | revoked. Set to revoked by POST /team-members/:token/revoke. Row is preserved for audit; not deleted.';

COMMENT ON COLUMN public.proofpix_team_members.photo_count IS
  'Count of photo uploads attributed to this member via matching captured_by. Bumped by POST /jobs/:jobId/photos.';
