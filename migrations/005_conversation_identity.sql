-- Fix conversation identity: scope by business endpoint, not just participant phone
-- Without this, the same customer talking to two different business numbers merges into one conversation
--
-- Deterministic conversation key: (user_id, provider, endpoint_phone, participant_phone)
-- - endpoint_phone = our business number (the OpenPhone line)
-- - participant_phone = the customer/external number

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS endpoint_phone varchar;

COMMENT ON COLUMN communication_conversations.endpoint_phone IS
  'Business-side phone number (our number). Together with participant_phone forms the unique conversation identity.';

-- Unique index: same user + same provider + same endpoint + same participant = one conversation
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_conv_identity
  ON communication_conversations(user_id, provider, endpoint_phone, participant_phone)
  WHERE endpoint_phone IS NOT NULL;

NOTIFY pgrst, 'reload schema';
