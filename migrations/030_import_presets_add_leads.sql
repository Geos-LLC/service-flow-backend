-- Extend import_mapping_presets.target CHECK to include 'leads'.
-- Leads are a separate table from customers (with pipeline_id, stage_id,
-- value, etc.) and the Data Import flow now supports them as a 6th type.

ALTER TABLE import_mapping_presets
  DROP CONSTRAINT IF EXISTS import_mapping_presets_target_check;

ALTER TABLE import_mapping_presets
  ADD CONSTRAINT import_mapping_presets_target_check
  CHECK (target IN ('customers','leads','jobs','team_members','services','territories'));

NOTIFY pgrst, 'reload schema';
