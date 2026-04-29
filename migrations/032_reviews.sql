-- Reviews — unified store for customer reviews from any source.
--
-- Designed so future Google / Yelp / Thumbtack / Booking Koala sync jobs
-- can write into the same table as the manual CSV import. Reviews
-- optionally link to a customer and/or a job; both are nullable because
-- platforms don't always give you enough info to match.

CREATE TABLE IF NOT EXISTS public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  customer_id integer REFERENCES public.customers(id) ON DELETE SET NULL,
  job_id integer REFERENCES public.jobs(id) ON DELETE SET NULL,

  rating numeric,
  rating_max integer DEFAULT 5,
  review_text text,

  reviewer_name varchar,
  reviewer_email varchar,

  source varchar NOT NULL,            -- google | yelp | thumbtack | booking_koala | direct | ...
  external_id varchar,                -- platform's review ID
  external_url text,                  -- link back to the review on the platform

  review_date timestamptz,

  response_text text,
  response_date timestamptz,

  status varchar DEFAULT 'published', -- published | hidden | flagged | pending
  metadata jsonb,

  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Idempotent sync: same source + external_id can only land once per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user_source_external
  ON reviews(user_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reviews_user_customer
  ON reviews(user_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reviews_user_job
  ON reviews(user_id, job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reviews_user_source_date
  ON reviews(user_id, source, review_date DESC);

-- Allow the import_mapping_presets target CHECK to include 'reviews'
ALTER TABLE import_mapping_presets
  DROP CONSTRAINT IF EXISTS import_mapping_presets_target_check;

ALTER TABLE import_mapping_presets
  ADD CONSTRAINT import_mapping_presets_target_check
  CHECK (target IN ('customers','leads','jobs','team_members','services','territories','reviews'));

NOTIFY pgrst, 'reload schema';
