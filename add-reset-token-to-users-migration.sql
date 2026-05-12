-- Add password reset token columns to users (owner/admin) table.
-- team_members already has these columns; this brings users in line so the
-- unified /api/auth/forgot-password + /api/auth/reset-password flow can work
-- for both account types.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS reset_token character varying,
  ADD COLUMN IF NOT EXISTS reset_token_expires timestamp without time zone;

CREATE INDEX IF NOT EXISTS idx_users_reset_token ON public.users (reset_token)
  WHERE reset_token IS NOT NULL;
