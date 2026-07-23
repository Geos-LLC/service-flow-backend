-- ProofPix integration — richer device metadata on connections.
--
-- Adds display fields for the SF /settings/proofpix devices list so
-- admins can identify each paired device (model, OS, role) and see
-- where/when it was last used.
--
-- All columns nullable — existing rows and any mobile client that
-- hasn't been updated to send them yet stay valid. Backend fills what
-- it can (paired_from_ip / last_seen_ip from req.ip); the rest is
-- populated by the ProofPix mobile client when it sends them at
-- /connect/redeem.
--
-- Rollback: 069_proofpix_connection_device_metadata_down.sql.

ALTER TABLE public.proofpix_connections
  ADD COLUMN IF NOT EXISTS device_model     TEXT,
  ADD COLUMN IF NOT EXISTS os_name          TEXT,
  ADD COLUMN IF NOT EXISTS os_version       TEXT,
  ADD COLUMN IF NOT EXISTS role             TEXT,
  ADD COLUMN IF NOT EXISTS paired_from_ip   TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_ip     TEXT;

COMMENT ON COLUMN public.proofpix_connections.device_model IS
  'Free-form device model string supplied by ProofPix mobile at /connect/redeem, e.g. "iPhone 15 Pro". NULL when the mobile client did not send it.';

COMMENT ON COLUMN public.proofpix_connections.os_name IS
  'OS family from the mobile client, e.g. "iOS" or "Android". NULL when not sent.';

COMMENT ON COLUMN public.proofpix_connections.os_version IS
  'OS version string from the mobile client, e.g. "18.2". NULL when not sent.';

COMMENT ON COLUMN public.proofpix_connections.role IS
  'ProofPix-side role classification, e.g. "admin" or "team_member". NULL when not sent.';

COMMENT ON COLUMN public.proofpix_connections.paired_from_ip IS
  'Client IP observed by SF backend at /connect/redeem. Captured server-side (req.ip, trust-proxy honored) — no mobile change needed. Stored as TEXT to accept IPv4 + IPv6 without INET-driver quirks.';

COMMENT ON COLUMN public.proofpix_connections.last_seen_ip IS
  'Client IP observed at the most recent /connect/refresh. Updated best-effort alongside last_used_at.';
