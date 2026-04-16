-- Add company (lead source) column to communication_conversations
-- Sourced from OpenPhone contact "company" field via Sigcore sync

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS company varchar;

CREATE INDEX IF NOT EXISTS idx_comm_conv_company ON communication_conversations(company) WHERE company IS NOT NULL;

NOTIFY pgrst, 'reload schema';
