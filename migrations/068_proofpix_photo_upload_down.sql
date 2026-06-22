-- Rollback for 068_proofpix_photo_upload.sql.
--
-- Re-asserting customer_id NOT NULL is only safe if no rows have been
-- inserted with null customer_id since the up migration ran. If any have
-- (e.g., ProofPix uploads against jobs with no customer linked), this
-- ALTER will fail — backfill or hard-delete those rows first.

DROP INDEX IF EXISTS public.uq_customer_files_proofpix_photo;

ALTER TABLE public.customer_files
  ALTER COLUMN customer_id SET NOT NULL;

ALTER TABLE public.customer_files
  DROP COLUMN IF EXISTS proofpix_metadata,
  DROP COLUMN IF EXISTS proofpix_photo_id,
  DROP COLUMN IF EXISTS source;
