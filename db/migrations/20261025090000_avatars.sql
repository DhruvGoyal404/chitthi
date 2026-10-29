-- migrate:up
-- Avatars are a copy we keep (docs/MEDIA.md, "Avatars"): at sign-in the server fetches the
-- provider's picture, re-encodes it and stores it with the media under a random key, and serves
-- it from our own origin, so no viewer's browser contacts Google or GitHub. avatar_url keeps the
-- provider's address the copy came from; avatar_key is the stored copy.
ALTER TABLE users ADD COLUMN avatar_key text;
ALTER TABLE users ADD CONSTRAINT users_avatar_key_format CHECK (avatar_key IS NULL OR avatar_key ~ '^[0-9a-f]{32}$');
-- One file, one owner; also what the media sweeper looks keys up by.
CREATE UNIQUE INDEX users_avatar_key_key ON users (avatar_key) WHERE avatar_key IS NOT NULL;
GRANT UPDATE (avatar_key) ON users TO chitthi_app;

-- migrate:down
REVOKE UPDATE (avatar_key) ON users FROM chitthi_app;
DROP INDEX users_avatar_key_key;
ALTER TABLE users DROP CONSTRAINT users_avatar_key_format;
ALTER TABLE users DROP COLUMN avatar_key;
