-- Communication tables for Sigcore-backed unified inbox
-- Run via Supabase SQL Editor or Management API

-- CRM-side settings: stores Sigcore tenant credentials and preferences
CREATE TABLE IF NOT EXISTS public.communication_settings (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  sigcore_tenant_id text,
  sigcore_tenant_api_key text,
  sigcore_webhook_subscription_id text,
  sigcore_webhook_secret text,
  connection_status varchar NOT NULL DEFAULT 'disconnected',
  openphone_connected boolean DEFAULT false,
  cached_phone_numbers jsonb DEFAULT '[]'::jsonb,
  preferences jsonb DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(user_id)
);

-- CRM-indexed conversations: local copies for UI, linkage, unread/archive/search
CREATE TABLE IF NOT EXISTS public.communication_conversations (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  sigcore_conversation_id text,
  provider varchar NOT NULL DEFAULT 'openphone',
  channel varchar NOT NULL DEFAULT 'sms',
  participant_phone varchar,
  participant_name varchar,
  customer_id integer,
  lead_id integer,
  last_preview text,
  last_event_at timestamptz,
  unread_count integer DEFAULT 0,
  is_archived boolean DEFAULT false,
  is_read boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_conv_user_event ON communication_conversations(user_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_conv_sigcore ON communication_conversations(sigcore_conversation_id);
CREATE INDEX IF NOT EXISTS idx_comm_conv_phone ON communication_conversations(participant_phone);

-- CRM-indexed messages: local copies populated via Sigcore webhooks
CREATE TABLE IF NOT EXISTS public.communication_messages (
  id serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES public.communication_conversations(id) ON DELETE CASCADE,
  sigcore_message_id text,
  provider_message_id text,
  direction varchar NOT NULL DEFAULT 'in',
  channel varchar NOT NULL DEFAULT 'sms',
  body text,
  from_number varchar,
  to_number varchar,
  sender_role varchar DEFAULT 'customer',
  status varchar DEFAULT 'delivered',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_msg_conv ON communication_messages(conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_msg_sigcore ON communication_messages(sigcore_message_id) WHERE sigcore_message_id IS NOT NULL;

-- CRM-indexed call events
CREATE TABLE IF NOT EXISTS public.communication_calls (
  id serial PRIMARY KEY,
  conversation_id integer REFERENCES public.communication_conversations(id) ON DELETE SET NULL,
  sigcore_call_id text,
  provider_call_id text,
  direction varchar NOT NULL DEFAULT 'in',
  from_number varchar,
  to_number varchar,
  duration_seconds integer DEFAULT 0,
  status varchar DEFAULT 'completed',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_call_sigcore ON communication_calls(sigcore_call_id) WHERE sigcore_call_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
