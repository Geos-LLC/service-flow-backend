-- Migration: Cleaner Ledger System
-- Run this in Supabase SQL Editor
-- Creates cleaner_ledger and cleaner_payout_batch tables
-- Adds payout preference fields to team_members

-- 1. Create cleaner_payout_batch table
CREATE TABLE IF NOT EXISTS public.cleaner_payout_batch (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  team_member_id integer NOT NULL REFERENCES public.team_members(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  paid_at timestamp without time zone,
  note text,
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  created_by integer REFERENCES public.users(id)
);

-- 2. Create cleaner_ledger table
CREATE TABLE IF NOT EXISTS public.cleaner_ledger (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  team_member_id integer NOT NULL REFERENCES public.team_members(id),
  job_id integer REFERENCES public.jobs(id),
  type varchar NOT NULL CHECK (type IN ('earning', 'tip', 'incentive', 'cash_collected', 'adjustment', 'payout')),
  amount numeric(12,2) NOT NULL,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  metadata jsonb,
  payout_batch_id integer REFERENCES public.cleaner_payout_batch(id),
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  created_by integer REFERENCES public.users(id)
);

-- 3. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_team_member ON public.cleaner_ledger (team_member_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_job ON public.cleaner_ledger (job_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_payout_batch ON public.cleaner_ledger (payout_batch_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_type ON public.cleaner_ledger (type);
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_effective_date ON public.cleaner_ledger (effective_date);
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_user_date ON public.cleaner_ledger (user_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_cleaner_ledger_unpaid ON public.cleaner_ledger (team_member_id) WHERE payout_batch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_cleaner_payout_batch_team_member ON public.cleaner_payout_batch (team_member_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_payout_batch_status ON public.cleaner_payout_batch (status);
CREATE INDEX IF NOT EXISTS idx_cleaner_payout_batch_user ON public.cleaner_payout_batch (user_id);

-- 4. Add payout preference fields to team_members
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS payout_schedule_type varchar DEFAULT 'manual';
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS payout_day_of_week integer;
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS payout_interval_days integer;
