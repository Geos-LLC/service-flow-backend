-- Rollback for 066_proofpix_connections.sql.

DROP INDEX IF EXISTS public.idx_proofpix_connections_user_active;
DROP INDEX IF EXISTS public.uq_proofpix_connections_token_hash;
DROP TABLE IF EXISTS public.proofpix_connections;

DROP INDEX IF EXISTS public.idx_proofpix_connect_codes_expires;
DROP INDEX IF EXISTS public.idx_proofpix_connect_codes_user;
DROP TABLE IF EXISTS public.proofpix_connect_codes;
