-- Add lead_cost column to leads (CPL / acquisition cost — what the user
-- paid the lead source for this lead, e.g. Thumbtack lead price).
--
-- Distinct from leads.value (the estimated deal value / lead price the
-- *customer* might pay if they convert).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_cost numeric;

NOTIFY pgrst, 'reload schema';
