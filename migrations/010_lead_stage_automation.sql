-- ============================================================================
-- Migration 010: Lead Stage Automation Rules
--
-- Configurable rules that automatically progress leads through pipeline
-- stages based on communication events from LeadBridge (Thumbtack/Yelp).
--
-- Events:
--   lead_received      — new lead arrives from TT/Yelp
--   first_reply_sent   — agent sends first outbound message
--   conversation_ongoing — messages after first reply (before proposal)
--   proposal_sent      — quote/proposal sent to customer
--   job_created        — job created for this lead (converts to customer)
--
-- Each rule maps: event → target stage (per user, per channel)
-- Users can customize which events trigger which stages.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lead_stage_automation_rules (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),

  -- Rule identity
  channel varchar NOT NULL,                -- 'thumbtack', 'yelp', 'all'
  event_type varchar NOT NULL,             -- 'lead_received', 'first_reply_sent', 'conversation_ongoing', 'proposal_sent', 'job_created'

  -- Target stage
  target_stage_id integer NOT NULL REFERENCES public.lead_stages(id),

  -- Behavior
  enabled boolean NOT NULL DEFAULT true,
  auto_convert_to_customer boolean DEFAULT false,  -- for 'job_created' event: also convert lead → customer

  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- One rule per user + channel + event
CREATE UNIQUE INDEX IF NOT EXISTS idx_lsar_unique_rule
  ON lead_stage_automation_rules(user_id, channel, event_type);

-- User listing
CREATE INDEX IF NOT EXISTS idx_lsar_user
  ON lead_stage_automation_rules(user_id, enabled);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lsar_updated_at ON lead_stage_automation_rules;
CREATE TRIGGER trg_lsar_updated_at
  BEFORE UPDATE ON lead_stage_automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE lead_stage_automation_rules IS
  'Configurable rules for automatic lead stage progression based on communication events. Per user, per channel.';

COMMENT ON COLUMN lead_stage_automation_rules.event_type IS
  'lead_received: new lead from platform. first_reply_sent: agent sends first message. conversation_ongoing: further messages. proposal_sent: quote sent. job_created: job created (optionally converts to customer).';

NOTIFY pgrst, 'reload schema';
