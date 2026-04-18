-- Payment reconcile sweep: catches payments that ZB webhooks missed.
-- Webhook-caught payments do NOT appear in these tables — only catches from the sweep.

CREATE TABLE IF NOT EXISTS payment_reconcile_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  jobs_scanned INT NOT NULL DEFAULT 0,
  payments_caught INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  error_details TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'cron' -- 'cron' | 'manual'
);

CREATE INDEX IF NOT EXISTS idx_payment_reconcile_runs_user_started
  ON payment_reconcile_runs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS payment_reconcile_catches (
  id SERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES payment_reconcile_runs(id) ON DELETE CASCADE,
  user_id INT NOT NULL,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  zb_invoice_id TEXT,
  zb_transaction_id TEXT,
  amount NUMERIC(10, 2) NOT NULL,
  payment_method TEXT,
  caught_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_reconcile_catches_user_caught
  ON payment_reconcile_catches(user_id, caught_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_reconcile_catches_run
  ON payment_reconcile_catches(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_reconcile_catches_job
  ON payment_reconcile_catches(job_id) -- one catch per job (later runs skip if already paid)
  WHERE job_id IS NOT NULL;
