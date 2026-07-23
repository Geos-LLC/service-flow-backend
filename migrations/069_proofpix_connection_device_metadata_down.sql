-- Rollback: 069_proofpix_connection_device_metadata.sql

ALTER TABLE public.proofpix_connections
  DROP COLUMN IF EXISTS device_model,
  DROP COLUMN IF EXISTS os_name,
  DROP COLUMN IF EXISTS os_version,
  DROP COLUMN IF EXISTS role,
  DROP COLUMN IF EXISTS paired_from_ip,
  DROP COLUMN IF EXISTS last_seen_ip;
