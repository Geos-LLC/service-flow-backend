-- ServiceFlow workspace + membership tables
-- Separates workspace identity from user identity.
-- Users connect to workspaces via sf_workspace_users (membership).

CREATE TABLE IF NOT EXISTS public.sf_workspaces (
  id serial PRIMARY KEY,
  name varchar NOT NULL,
  sigcore_workspace_id uuid,         -- product_workspaces.id in Sigcore
  sigcore_business_id uuid,          -- businesses.id in Sigcore
  status varchar NOT NULL DEFAULT 'active',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sf_workspaces_sigcore_wid ON sf_workspaces(sigcore_workspace_id);
CREATE INDEX IF NOT EXISTS idx_sf_workspaces_sigcore_bid ON sf_workspaces(sigcore_business_id);

CREATE TABLE IF NOT EXISTS public.sf_workspace_users (
  id serial PRIMARY KEY,
  workspace_id integer NOT NULL REFERENCES public.sf_workspaces(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role varchar NOT NULL DEFAULT 'owner',
  status varchar NOT NULL DEFAULT 'active',
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_wu_workspace ON sf_workspace_users(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sf_wu_user ON sf_workspace_users(user_id);

NOTIFY pgrst, 'reload schema';
