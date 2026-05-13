-- 038_push_subscriptions.sql
-- Web Push subscription store for team members (PWA).
-- Each device/browser registers once; we send to all subscriptions of a given team_member_id.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                BIGSERIAL PRIMARY KEY,
  team_member_id    BIGINT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint          TEXT NOT NULL,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_team_member
  ON push_subscriptions (team_member_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id);
