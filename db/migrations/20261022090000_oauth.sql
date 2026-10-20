-- migrate:up
-- Real sign-in (Google OIDC, GitHub OAuth). See api/src/oauth/.

-- An OAuth/OIDC flow in progress: the state is stored hashed and used once (DELETE … RETURNING),
-- with the PKCE verifier and (for OIDC) the nonce it was started with. Ten minutes to finish.
CREATE TABLE oauth_flows (
  state_hash     bytea       PRIMARY KEY,
  provider       text        NOT NULL,
  purpose        text        NOT NULL,
  user_id        uuid        REFERENCES users (id) ON DELETE CASCADE,
  code_verifier  text        NOT NULL,
  nonce          text,
  return_to      text        NOT NULL DEFAULT '/',
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  CONSTRAINT oauth_flows_state_len CHECK (octet_length(state_hash) = 32),
  CONSTRAINT oauth_flows_provider_check CHECK (provider IN ('google', 'github')),
  CONSTRAINT oauth_flows_purpose CHECK ((purpose = 'login' AND user_id IS NULL) OR (purpose = 'link' AND user_id IS NOT NULL))
);
CREATE INDEX oauth_flows_expires_idx ON oauth_flows (expires_at);

-- A first sign-in waiting for onboarding (pick a handle). Holds the verified provider profile;
-- the browser holds only the token, stored here hashed. No user row exists until onboarding.
CREATE TABLE pending_signups (
  token_hash    bytea       PRIMARY KEY,
  provider      text        NOT NULL,
  subject       text        NOT NULL,
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  avatar_url    text,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  CONSTRAINT pending_signups_token_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT pending_signups_provider_check CHECK (provider IN ('google', 'github'))
);
CREATE INDEX pending_signups_expires_idx ON pending_signups (expires_at);

-- The provider's picture (https only), shown as the avatar.
ALTER TABLE users ADD COLUMN avatar_url text;
ALTER TABLE users ADD CONSTRAINT users_avatar_url_check CHECK (avatar_url IS NULL OR (avatar_url ~ '^https://' AND char_length(avatar_url) <= 500));

-- One identity per provider per account (linking a second Google account is refused).
CREATE UNIQUE INDEX identities_user_provider_key ON identities (user_id, provider);
-- "Never auto-link by email" needs a fast lookup of who already uses an address.
CREATE INDEX identities_email_idx ON identities (lower(email)) WHERE email IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON oauth_flows TO chitthi_app;
GRANT SELECT, INSERT, DELETE ON pending_signups TO chitthi_app;
GRANT INSERT (avatar_url), UPDATE (avatar_url) ON users TO chitthi_app;

-- migrate:down
REVOKE INSERT (avatar_url), UPDATE (avatar_url) ON users FROM chitthi_app;
DROP INDEX identities_email_idx;
DROP INDEX identities_user_provider_key;
ALTER TABLE users DROP CONSTRAINT users_avatar_url_check;
ALTER TABLE users DROP COLUMN avatar_url;
DROP TABLE pending_signups;
DROP TABLE oauth_flows;
