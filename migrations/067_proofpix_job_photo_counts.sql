-- ProofPix integration — PR 2: GET /jobs photo-count helper.
--
-- Single SQL function used by the /jobs response to populate the
-- per-job `photo_count` field. Avoids:
--   - N+1 round-trips (one HTTP call per job)
--   - Supabase's default 1000-row limit on a naive `.in()` fetch of
--     customer_files rows
--
-- Tenant-scoped on p_user_id so the function is safe to expose to any
-- authenticated SF role; a caller cannot use it to count photos on a
-- foreign tenant's jobs. (The route handler already verifies the JWT
-- before calling, but defense-in-depth.)
--
-- Rollback: 067_proofpix_job_photo_counts_down.sql.

CREATE OR REPLACE FUNCTION public.proofpix_job_photo_counts(
  p_user_id  integer,
  p_job_ids  integer[]
)
RETURNS TABLE(job_id integer, photo_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cf.job_id, COUNT(*)::bigint AS photo_count
  FROM public.customer_files cf
  WHERE cf.user_id = p_user_id
    AND cf.job_id  = ANY(p_job_ids)
    AND cf.deleted_at IS NULL
  GROUP BY cf.job_id;
$$;

COMMENT ON FUNCTION public.proofpix_job_photo_counts(integer, integer[]) IS
  'Per-job photo counts scoped to a single tenant. Used by GET /api/integrations/proofpix/jobs to populate photo_count without N+1 queries.';
