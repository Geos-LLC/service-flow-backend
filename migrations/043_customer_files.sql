-- ═══════════════════════════════════════════════════════════════
-- Migration 043: Customer Files
-- ═══════════════════════════════════════════════════════════════
-- Per-customer file/photo storage backing the Files tab on the
-- customer detail page. Photos and documents uploaded against a
-- customer (or implicitly attached via a specific job) land here.
--
-- File contents themselves live in Supabase Storage under the
-- `job-attachments` bucket (`customer-{customerId}` folder). This
-- table is just the metadata index.

CREATE TABLE IF NOT EXISTS customer_files (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id        INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  file_url      TEXT NOT NULL,
  mime_type     VARCHAR(120),
  size_bytes    BIGINT,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customer_files_customer
  ON customer_files(customer_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_files_user
  ON customer_files(user_id);

CREATE INDEX IF NOT EXISTS idx_customer_files_job
  ON customer_files(job_id)
  WHERE job_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
