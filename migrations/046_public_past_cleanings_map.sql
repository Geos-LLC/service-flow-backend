-- ═══════════════════════════════════════════════════════════════
-- Migration 046: Public Past Cleanings Map Widget (issue #3)
-- ═══════════════════════════════════════════════════════════════
-- Two tables:
--   * public_job_map_projection — sanitized projection of completed jobs.
--     The public widget endpoint reads ONLY from this table, never from
--     the raw `jobs` table. This guarantees that newly-added private
--     columns on jobs cannot accidentally leak through the public
--     surface, and gives us an explicit place to apply geo-privacy.
--   * tenant_widget_settings — per-tenant on/off + tunables for the
--     public widget. Tenant disabling the widget stops public access
--     immediately (no projection rebuild required).
--
-- Privacy contract:
--   - The projection stores ONLY public-safe columns: approximated
--     lat/lng, city/neighborhood, service type, completed month/year.
--   - public_geo_method records how the coordinates were derived
--     (`jitter` | `zip_centroid` | `city_centroid`) so audits can show
--     the precision policy applied to each pin.
--   - No customer ids, no customer names, no street/zip, no notes, no
--     scheduled_time, no internal job id beyond the FK used for upserts.

CREATE TABLE IF NOT EXISTS public_job_map_projection (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL,
  job_id              BIGINT NOT NULL,
  public_lat          NUMERIC(8, 5) NOT NULL,
  public_lng          NUMERIC(8, 5) NOT NULL,
  public_geo_method   TEXT NOT NULL,
  service_type        TEXT,
  city                TEXT,
  completed_month     SMALLINT NOT NULL,
  completed_year      SMALLINT NOT NULL,
  completed_on        DATE NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pjmp_tenant_job_unique UNIQUE (tenant_id, job_id),
  CONSTRAINT pjmp_geo_method_chk
    CHECK (public_geo_method IN ('jitter', 'zip_centroid', 'city_centroid')),
  CONSTRAINT pjmp_lat_range_chk
    CHECK (public_lat >= -90 AND public_lat <= 90),
  CONSTRAINT pjmp_lng_range_chk
    CHECK (public_lng >= -180 AND public_lng <= 180),
  CONSTRAINT pjmp_month_chk
    CHECK (completed_month BETWEEN 1 AND 12),
  CONSTRAINT pjmp_year_chk
    CHECK (completed_year BETWEEN 2000 AND 2100)
);

-- Hot path query: read by tenant, ordered by completed_on DESC, with an
-- optional date-range cutoff on completed_on.
CREATE INDEX IF NOT EXISTS idx_pjmp_tenant_completed_on
  ON public_job_map_projection (tenant_id, completed_on DESC);

-- Used by the projection refresher to find rows for a given job quickly
-- when the source job's status flips from completed -> non-completed.
CREATE INDEX IF NOT EXISTS idx_pjmp_job
  ON public_job_map_projection (job_id);


CREATE TABLE IF NOT EXISTS tenant_widget_settings (
  tenant_id              BIGINT PRIMARY KEY,
  past_cleanings_enabled BOOLEAN NOT NULL DEFAULT false,
  past_cleanings_max_pins INTEGER NOT NULL DEFAULT 250,
  past_cleanings_range   TEXT NOT NULL DEFAULT '365d',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tws_max_pins_chk
    CHECK (past_cleanings_max_pins >= 0 AND past_cleanings_max_pins <= 500),
  CONSTRAINT tws_range_chk
    CHECK (past_cleanings_range IN ('90d', '365d', 'all'))
);
