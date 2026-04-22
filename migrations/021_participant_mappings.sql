-- PR4: Participant-based identity — Sigcore participant as long-term identity root
-- Sigcore owns provider truth + communication identity; SF owns CRM identity + mapping.

CREATE TABLE IF NOT EXISTS public.communication_participant_mappings (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES public.users(id),
  provider varchar NOT NULL DEFAULT 'openphone',

  sigcore_participant_id text,
  sigcore_participant_key text,
  participant_phone_e164 varchar,

  provider_contact_id text,

  crm_contact_id integer,           -- reserved (SF has no `contacts` table yet)
  crm_lead_id integer,              -- FK not enforced — leads may be deleted/archived
  crm_customer_id integer,          -- FK not enforced — same reason

  mapping_status varchar NOT NULL DEFAULT 'unmapped'
    CHECK (mapping_status IN ('mapped','ambiguous','unmapped','manual')),
  mapping_source varchar
    CHECK (mapping_source IS NULL OR mapping_source IN ('phone_exact','manual','backfill')),

  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Primary uniqueness — participantId
CREATE UNIQUE INDEX IF NOT EXISTS idx_ppm_sigcore_id
  ON public.communication_participant_mappings(tenant_id, provider, sigcore_participant_id)
  WHERE sigcore_participant_id IS NOT NULL;

-- Transitional uniqueness — participantKey when participantId is still missing.
-- Prevents duplicate mapping rows for the same person during the transition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ppm_sigcore_key
  ON public.communication_participant_mappings(tenant_id, provider, sigcore_participant_key)
  WHERE sigcore_participant_id IS NULL AND sigcore_participant_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppm_phone  ON public.communication_participant_mappings(participant_phone_e164);
CREATE INDEX IF NOT EXISTS idx_ppm_status ON public.communication_participant_mappings(mapping_status);
CREATE INDEX IF NOT EXISTS idx_ppm_crm_customer ON public.communication_participant_mappings(crm_customer_id) WHERE crm_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ppm_crm_lead ON public.communication_participant_mappings(crm_lead_id) WHERE crm_lead_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
