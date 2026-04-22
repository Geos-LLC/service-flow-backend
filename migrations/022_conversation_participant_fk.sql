-- PR4: Link conversations to participant mappings + pending flag for sparse coverage

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS participant_mapping_id integer REFERENCES public.communication_participant_mappings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS participant_pending boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_comm_conv_participant ON public.communication_conversations(participant_mapping_id)
  WHERE participant_mapping_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_conv_pending ON public.communication_conversations(participant_pending)
  WHERE participant_pending = true;

NOTIFY pgrst, 'reload schema';
