-- Per-job breakdown of fees (Stripe processing, etc.) synced from Zenbooker's
-- invoice.adjustments_applied[]. The scalar total stays in jobs.additional_fees.
-- Each row in the jsonb array: { name, type, amount, value?, value_type? }
-- Type is 'fee' for third-party fees that should NOT count toward cleaner commission.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fees_breakdown JSONB;
NOTIFY pgrst, 'reload schema';
