-- LB linkage health RPC — backs GET /api/integrations/leadbridge/linkage-health.
-- Buckets the jobs that are unlinked-but-have-customer into "recoverable"
-- (exactly one LB-linked lead reachable via converted_customer_id) and
-- "ambiguous" (more than one distinct lb_external_request_id across leads
-- for the same customer).
--
-- Tenant-scoped — caller passes p_user_id. Returns one row.
-- Read-only — no side effects.

CREATE OR REPLACE FUNCTION lb_linkage_unlinked_job_buckets(p_user_id BIGINT)
RETURNS TABLE (
  with_customer            BIGINT,
  recoverable_single_lead  BIGINT,
  ambiguous                BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH unlinked AS (
    SELECT j.id AS job_id, j.customer_id
    FROM public.jobs j
    WHERE j.user_id = p_user_id
      AND j.lb_external_request_id IS NULL
      AND j.customer_id IS NOT NULL
  ),
  per_job AS (
    SELECT u.job_id,
           count(l.id) FILTER (WHERE l.lb_external_request_id IS NOT NULL) AS linked_lead_count,
           count(DISTINCT l.lb_external_request_id) FILTER (WHERE l.lb_external_request_id IS NOT NULL) AS distinct_ext
    FROM unlinked u
    LEFT JOIN public.leads l
      ON l.user_id = p_user_id
     AND l.converted_customer_id = u.customer_id
    GROUP BY u.job_id
  )
  SELECT
    (count(*))::BIGINT                                       AS with_customer,
    (count(*) FILTER (WHERE distinct_ext = 1))::BIGINT       AS recoverable_single_lead,
    (count(*) FILTER (WHERE distinct_ext > 1))::BIGINT       AS ambiguous
  FROM per_job;
$$;

GRANT EXECUTE ON FUNCTION lb_linkage_unlinked_job_buckets(BIGINT) TO anon, authenticated, service_role;

COMMENT ON FUNCTION lb_linkage_unlinked_job_buckets(BIGINT) IS
  'Returns three counts for the LB linkage health endpoint: jobs without lb_external_request_id that have a customer, of those the count recoverable via a single LB-linked lead, and the count ambiguous via multiple LB-linked leads.';
