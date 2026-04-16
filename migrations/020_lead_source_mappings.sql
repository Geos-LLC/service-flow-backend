-- Lead source mappings: map raw values (OpenPhone company, LB channel) to canonical source names
-- e.g. "Thumbtack S" → "Thumbtack", "Tumbtack J" → "Thumbtack"

CREATE TABLE IF NOT EXISTS public.lead_source_mappings (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  raw_value varchar NOT NULL,        -- the raw string from OpenPhone company or LB channel
  source_name varchar NOT NULL,      -- canonical source name (from lead_sources)
  provider varchar DEFAULT 'openphone', -- openphone or leadbridge
  created_at timestamptz DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_source_map_user_raw
  ON lead_source_mappings(user_id, raw_value, provider);

NOTIFY pgrst, 'reload schema';
