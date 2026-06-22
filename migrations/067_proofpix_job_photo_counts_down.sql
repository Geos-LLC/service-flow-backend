-- Rollback for 067_proofpix_job_photo_counts.sql.

DROP FUNCTION IF EXISTS public.proofpix_job_photo_counts(integer, integer[]);
