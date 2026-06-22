-- ProofPix integration — PR 3: photo upload schema.
--
-- Two changes to customer_files:
--   1. ProofPix metadata columns (source, proofpix_photo_id, proofpix_metadata)
--      so /api/integrations/proofpix/jobs/:jobId/photos can record where
--      the photo came from + the capture context (room, mode, gps, etc.).
--   2. customer_id → NULLABLE. Some SF jobs have no linked customer
--      (admin-created jobs that never got a customer attached). Without
--      this relax, those jobs can never receive ProofPix photos. The 4
--      existing readers of customer_files are safe: 3 filter BY
--      customer_id (null rows just don't appear in customer Files tabs),
--      1 sums size_bytes column-only. Verified in code review.
--
-- The unique partial index on (user_id, proofpix_photo_id) is the
-- backbone of the spec's idempotency requirement: ProofPix-native
-- retries uploads on network failures with the same proofpix_photo_id,
-- and SF must return the existing crm_photo_id rather than creating
-- duplicate rows. The partial WHERE clause keeps the constraint from
-- biting any non-ProofPix customer_files rows.
--
-- Rollback: 068_proofpix_photo_upload_down.sql.

ALTER TABLE public.customer_files
  ADD COLUMN IF NOT EXISTS source             TEXT,
  ADD COLUMN IF NOT EXISTS proofpix_photo_id  TEXT,
  ADD COLUMN IF NOT EXISTS proofpix_metadata  JSONB;

ALTER TABLE public.customer_files
  ALTER COLUMN customer_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_files_proofpix_photo
  ON public.customer_files (user_id, proofpix_photo_id)
  WHERE proofpix_photo_id IS NOT NULL;

COMMENT ON COLUMN public.customer_files.source IS
  'Where the file came from: ''proofpix'' for the mobile integration, NULL for SF-native uploads (Files tab, job notes). Future integrations add their own value (''zenbooker_attachment'', etc).';

COMMENT ON COLUMN public.customer_files.proofpix_photo_id IS
  'ProofPix-side stable id for the photo. Used as the idempotency key on POST /api/integrations/proofpix/jobs/:jobId/photos so a retried mobile upload returns the existing crm_photo_id rather than duplicating.';

COMMENT ON COLUMN public.customer_files.proofpix_metadata IS
  'Capture context from the ProofPix client: { mode, room, timestamp, gps, captured_by, notes, proofpix_project_id }. Stored verbatim — SF does not interpret these fields, they live here for traceability and future surfaces.';
