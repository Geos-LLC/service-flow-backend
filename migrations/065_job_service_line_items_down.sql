ALTER TABLE public.jobs DROP COLUMN IF EXISTS service_line_items;
NOTIFY pgrst, 'reload schema';
