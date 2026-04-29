-- Import mapping presets: saved CSV-header → SF-field mappings for the
-- generic Data Import flow.
--
-- Two tiers:
--   * is_system = true  → seeded built-in presets (Booking Koala, ZenBooker, ...)
--                         visible to every tenant, read-only. user_id is NULL.
--   * is_system = false → user-saved presets, scoped to user_id, only visible
--                         to that user.
--
-- target = 'customers' | 'jobs' | 'team_members' | 'services' | 'territories'
--
-- mapping is { sf_field_key: csv_header_name } e.g.
--   { "firstName": "First Name", "email": "Email Address", ... }

CREATE TABLE IF NOT EXISTS public.import_mapping_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer REFERENCES public.users(id) ON DELETE CASCADE,
  name varchar NOT NULL,
  target varchar NOT NULL CHECK (target IN ('customers','jobs','team_members','services','territories')),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  CHECK ((is_system = true AND user_id IS NULL) OR (is_system = false AND user_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_import_mapping_presets_user
  ON import_mapping_presets(user_id, target)
  WHERE is_system = false;

CREATE INDEX IF NOT EXISTS idx_import_mapping_presets_system
  ON import_mapping_presets(target)
  WHERE is_system = true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_mapping_presets_user_name
  ON import_mapping_presets(user_id, target, name)
  WHERE is_system = false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_mapping_presets_system_name
  ON import_mapping_presets(target, name)
  WHERE is_system = true;

-- ---------------------------------------------------------------------------
-- Seed system presets
-- ---------------------------------------------------------------------------

-- Booking Koala — Customers export
INSERT INTO import_mapping_presets (name, target, mapping, is_system, description)
VALUES (
  'Booking Koala',
  'customers',
  '{
    "firstName": "First Name",
    "lastName": "Last Name",
    "email": "Email Address",
    "phone": "Phone Number",
    "additionalPhone": "Additional Phone Number(s)",
    "address": "Address",
    "apt": "Apt. No.",
    "city": "City",
    "state": "State",
    "zipCode": "Zip/Postal Code",
    "companyName": "Company Name",
    "notes": "Note",
    "status": "Status",
    "tags": "Tags"
  }'::jsonb,
  true,
  'Booking Koala customer export (CSV/XLSX)'
)
ON CONFLICT DO NOTHING;

-- Booking Koala — Jobs/Bookings export
INSERT INTO import_mapping_presets (name, target, mapping, is_system, description)
VALUES (
  'Booking Koala',
  'jobs',
  '{
    "customerFirstName": "First name",
    "customerLastName": "Last name",
    "customerEmail": "Email",
    "phone": "Phone",
    "address": "Address",
    "apt": "Apt",
    "city": "City",
    "state": "State",
    "zipCode": "Zip/Postal code",
    "serviceName": "Service",
    "scheduledDate": "Booking start date time",
    "scheduledTime": "Booking start date time",
    "bookingStartDateTime": "Booking start date time",
    "bookingEndDateTime": "Booking end date time",
    "status": "Booking status",
    "price": "Final amount (USD)",
    "serviceTotal": "Service total (USD)",
    "finalAmount": "Final amount (USD)",
    "amountPaidByCustomer": "Amount paid by customer (USD)",
    "amountOwed": "Amount owed by customer (USD)",
    "paymentMethod": "Payment method",
    "duration": "Estimated job length (HH:MM)",
    "notes": "Booking note",
    "bookingNote": "Booking note",
    "providerNote": "Provider note",
    "specialNotes": "Special notes",
    "isRecurring": "Frequency",
    "recurringFrequency": "Frequency",
    "extras": "Extras",
    "excludes": "Excludes",
    "assignedCrewExternalId": "Provider details",
    "serviceRegionExternalId": "Location",
    "externalId": "Booking ID"
  }'::jsonb,
  true,
  'Booking Koala bookings/jobs export (CSV/XLSX)'
)
ON CONFLICT DO NOTHING;

-- ZenBooker — Jobs export
INSERT INTO import_mapping_presets (name, target, mapping, is_system, description)
VALUES (
  'ZenBooker',
  'jobs',
  '{
    "customerFirstName": "customer_name",
    "customerLastName": "customer_name",
    "customerEmail": "customer_email_text",
    "customerPhone": "customer_phone_text",
    "serviceName": "service_selected_text",
    "scheduledDate": "start_time_for_full_cal_date",
    "price": "price_number",
    "address": "job_address_geographic_address",
    "status": "live_status_text",
    "externalId": "_id",
    "jobRandomId": "job_random_id_text"
  }'::jsonb,
  true,
  'ZenBooker bookings export (CSV)'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
