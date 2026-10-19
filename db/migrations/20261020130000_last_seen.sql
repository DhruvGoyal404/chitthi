-- migrate:up
-- When a user was last connected. Written by the API when their last socket has been gone for
-- the presence grace period (api/src/realtime/presence.ts), and on shutdown.
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
GRANT UPDATE (last_seen_at) ON users TO chitthi_app;

-- migrate:down
REVOKE UPDATE (last_seen_at) ON users FROM chitthi_app;
ALTER TABLE users DROP COLUMN last_seen_at;
