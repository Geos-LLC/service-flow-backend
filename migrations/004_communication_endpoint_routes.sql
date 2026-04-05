-- Communication Endpoint Routes — deterministic routing table
-- Maps provider endpoints to workspaces. Primary runtime routing source.
-- Run via Supabase SQL Editor or Management API.

CREATE TABLE IF NOT EXISTS public.communication_endpoint_routes (
  id serial PRIMARY KEY,

  -- Target workspace
  workspace_id integer NOT NULL REFERENCES public.sf_workspaces(id) ON DELETE CASCADE,

  -- Provider identity (strongest deterministic key)
  provider varchar NOT NULL,                        -- openphone, twilio, leadbridge, callio
  provider_account_id varchar,                      -- provider's account/subaccount ID
  endpoint_id varchar,                              -- specific endpoint: phone number ID (PNm5YIDoXV), Twilio SID, webhook ID
  phone_number varchar,                             -- E.164 phone number if applicable

  -- Channel + role
  channel varchar NOT NULL DEFAULT 'sms',           -- sms, voice, email, marketplace
  role varchar,                                     -- leadbridge_assigned_number, callio_main_inbox, etc.
  purpose varchar,                                  -- lead_capture, main_business_line, etc.

  -- Routing control
  priority integer NOT NULL DEFAULT 0,              -- higher = preferred when multiple routes at same step
  is_active boolean NOT NULL DEFAULT true,          -- soft delete / deactivation

  -- Lifecycle tracking
  route_source varchar NOT NULL DEFAULT 'manual',   -- manual, auto_connect, auto_provision, backfill
  activated_at timestamptz DEFAULT NOW(),
  deactivated_at timestamptz,

  -- Debug
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Primary lookup: provider + endpoint_id + channel (Step A — exact endpoint match)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cer_provider_endpoint_channel
  ON communication_endpoint_routes(provider, endpoint_id, channel)
  WHERE endpoint_id IS NOT NULL AND is_active = true;

-- Step C: provider + provider_account_id
CREATE INDEX IF NOT EXISTS idx_cer_provider_account
  ON communication_endpoint_routes(provider, provider_account_id)
  WHERE provider_account_id IS NOT NULL AND is_active = true;

-- Step D: phone number fallback
CREATE INDEX IF NOT EXISTS idx_cer_phone
  ON communication_endpoint_routes(phone_number)
  WHERE phone_number IS NOT NULL AND is_active = true;

-- Workspace listing
CREATE INDEX IF NOT EXISTS idx_cer_workspace
  ON communication_endpoint_routes(workspace_id, is_active);

NOTIFY pgrst, 'reload schema';
