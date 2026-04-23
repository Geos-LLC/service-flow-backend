-- ═══════════════════════════════════════════════════════════════
-- Migration 025: Customer Properties
-- ═══════════════════════════════════════════════════════════════
-- Adds multi-address support per customer. Previously a customer had a single
-- address stored as `customers.address/city/state/zip_code`. That single row is
-- kept as a fallback during rollout, but `customer_properties` becomes the
-- source of truth for all addressing going forward. Each job can reference the
-- specific property it was booked for via `jobs.property_id`.

CREATE TABLE IF NOT EXISTS customer_properties (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label VARCHAR(120),
  street TEXT,
  suite VARCHAR(80),
  city VARCHAR(120),
  state VARCHAR(80),
  zip_code VARCHAR(20),
  country VARCHAR(80) DEFAULT 'USA',
  is_default BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_properties_customer
  ON customer_properties(customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_properties_user
  ON customer_properties(user_id);

-- At most one default per customer (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_properties_one_default
  ON customer_properties(customer_id)
  WHERE is_default = true;

-- Stamp each job with the property it was booked for.
-- Nullable so legacy / pre-migration rows still work.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES customer_properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_property ON jobs(property_id);

-- Reload PostgREST schema cache so Supabase client sees the new column
NOTIFY pgrst, 'reload schema';
