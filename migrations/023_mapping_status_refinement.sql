-- PR4.1 — Refine mapping_status domain to separate intentional-non-CRM states from
-- "needs attention" state. Aggregator + noise are intentional; unmapped = actionable.

ALTER TABLE public.communication_participant_mappings
  DROP CONSTRAINT IF EXISTS communication_participant_mappings_mapping_status_check;

ALTER TABLE public.communication_participant_mappings
  ADD CONSTRAINT communication_participant_mappings_mapping_status_check
  CHECK (mapping_status IN ('mapped','ambiguous','unmapped','manual','aggregator','noise'));

NOTIFY pgrst, 'reload schema';
