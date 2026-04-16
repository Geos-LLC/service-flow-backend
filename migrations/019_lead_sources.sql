-- Lead sources: user-managed list of lead source names
-- Replaces localStorage-based source list on frontend

CREATE TABLE IF NOT EXISTS public.lead_sources (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  name varchar NOT NULL,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_sources_user_name ON lead_sources(user_id, name);

NOTIFY pgrst, 'reload schema';
