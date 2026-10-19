-- migrate:up
-- Chitthi core schema: see docs/SCHEMA.md for the design and the reasoning behind each rule.
-- Integrity that the app must never be able to break lives here, in constraints and triggers:
-- gap-free per-conversation seq, the change cursor, membership windows, forward-only read
-- markers, immutable message identity, erasure on delete-for-everyone, no hard deletes.
-- Trigger functions that write counters are SECURITY DEFINER (owned by the migration role), so
-- chitthi_app needs no UPDATE privilege on those columns.

-- ───────────────────────────────────────────────────────────── handles
CREATE TABLE reserved_handles (
  handle text PRIMARY KEY,
  CONSTRAINT reserved_handles_lowercase CHECK (handle = lower(handle))
);
INSERT INTO reserved_handles (handle) VALUES
  ('abuse'), ('account'), ('admin'), ('administrator'), ('all'), ('anonymous'), ('api'), ('bot'),
  ('channel'), ('chitthi'), ('dev'), ('everyone'), ('guest'), ('help'), ('helpdesk'), ('here'),
  ('login'), ('logout'), ('mail'), ('mod'), ('moderator'), ('no_reply'), ('noreply'), ('null'),
  ('official'), ('owner'), ('postmaster'), ('root'), ('security'), ('settings'), ('signup'),
  ('staff'), ('support'), ('system'), ('team'), ('test'), ('undefined'), ('webmaster'), ('www');

-- ─────────────────────────────────────────────────────────────── users
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  handle        text        NOT NULL,
  display_name  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  CONSTRAINT users_handle_format    CHECK (handle ~ '^[A-Za-z0-9_]{3,20}$'),
  CONSTRAINT users_display_name_len CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 60)
);
-- Case-insensitive uniqueness; the handle keeps the casing its owner chose.
CREATE UNIQUE INDEX users_handle_lower_key ON users (lower(handle));

CREATE FUNCTION users_reject_reserved_handle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reserved_handles r WHERE r.handle = lower(NEW.handle)) THEN
    RAISE EXCEPTION 'handle is reserved'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_handle_reserved';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_reject_reserved_handle BEFORE INSERT OR UPDATE OF handle ON users
  FOR EACH ROW EXECUTE FUNCTION users_reject_reserved_handle();

-- ────────────────────────────────────────────────────────── identities
CREATE TABLE identities (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider        text        NOT NULL,
  subject         text        NOT NULL,
  email           text,
  email_verified  boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_check CHECK (provider IN ('google', 'github', 'dev')),
  CONSTRAINT identities_subject_len    CHECK (char_length(subject) BETWEEN 1 AND 255),
  CONSTRAINT identities_provider_subject_key UNIQUE (provider, subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);

-- ──────────────────────────────────────────────────────────── sessions
CREATE TABLE sessions (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    bytea       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_order   CHECK (expires_at > created_at),
  CONSTRAINT sessions_user_agent_len CHECK (char_length(user_agent) <= 200),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX sessions_user_live_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ─────────────────────────────────────────────────────── conversations
CREATE TABLE conversations (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind             text        NOT NULL,
  title            text,
  created_by       uuid        NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Highest message seq. Bumped only by messages_before_insert().
  last_seq         bigint      NOT NULL DEFAULT 0,
  -- Change cursor: bumped by every new message, edit and delete-for-everyone.
  change_seq       bigint      NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  CONSTRAINT conversations_kind_check    CHECK (kind IN ('direct', 'group')),
  CONSTRAINT conversations_title_by_kind CHECK (
    (kind = 'group'  AND title IS NOT NULL AND char_length(btrim(title)) BETWEEN 1 AND 80) OR
    (kind = 'direct' AND title IS NULL)),
  CONSTRAINT conversations_counters CHECK (last_seq >= 0 AND change_seq >= last_seq)
);

CREATE FUNCTION conversations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.last_seq < OLD.last_seq OR NEW.change_seq < OLD.change_seq THEN
    RAISE EXCEPTION 'conversation counters only increase' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable conversation column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_guard BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_guard();

-- Exactly one direct conversation per unordered pair (stored ordered; no self-DMs).
CREATE TABLE direct_conversations (
  conversation_id  uuid PRIMARY KEY REFERENCES conversations (id),
  user_lo          uuid NOT NULL REFERENCES users (id),
  user_hi          uuid NOT NULL REFERENCES users (id),
  CONSTRAINT direct_conversations_ordered  CHECK (user_lo < user_hi),
  CONSTRAINT direct_conversations_pair_key UNIQUE (user_lo, user_hi)
);

CREATE FUNCTION direct_conversations_check_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = NEW.conversation_id AND c.kind = 'direct') THEN
    RAISE EXCEPTION 'direct_conversations row needs a direct conversation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'direct_conversations_kind';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER direct_conversations_check_kind BEFORE INSERT OR UPDATE ON direct_conversations
  FOR EACH ROW EXECUTE FUNCTION direct_conversations_check_kind();

-- ──────────────────────────────────────────────── membership periods
-- One row per period of membership. A member sees messages with seq in [joined_seq, left_seq]
-- (left_seq NULL while active). Both bounds are set by triggers under the conversation's row
-- lock, so they are exact with respect to concurrent sends and can't be chosen by the app.
CREATE TABLE conversation_memberships (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  conversation_id  uuid        NOT NULL REFERENCES conversations (id),
  user_id          uuid        NOT NULL REFERENCES users (id),
  role             text        NOT NULL DEFAULT 'member',
  joined_seq       bigint      NOT NULL DEFAULT 0,
  joined_at        timestamptz NOT NULL DEFAULT now(),
  left_seq         bigint,
  left_at          timestamptz,
  left_reason      text,
  CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT memberships_left_shape CHECK (
    (left_at IS NULL AND left_seq IS NULL AND left_reason IS NULL) OR
    (left_at IS NOT NULL AND left_seq IS NOT NULL AND left_reason IN ('left', 'removed'))),
  CONSTRAINT memberships_window CHECK (joined_seq >= 1 AND (left_seq IS NULL OR left_seq >= joined_seq - 1))
);
CREATE UNIQUE INDEX memberships_one_active ON conversation_memberships (conversation_id, user_id) WHERE left_at IS NULL;
CREATE INDEX memberships_conv_user_idx ON conversation_memberships (conversation_id, user_id, joined_seq);
CREATE INDEX memberships_user_idx ON conversation_memberships (user_id, conversation_id);

-- ─────────────────────────────────────────────────────── read markers
-- One row per (conversation, user), created with the first membership. Watermarks only move
-- forward and never past the last seq the user can see.
CREATE TABLE read_markers (
  conversation_id     uuid        NOT NULL REFERENCES conversations (id),
  user_id             uuid        NOT NULL REFERENCES users (id),
  last_delivered_seq  bigint      NOT NULL DEFAULT 0,
  last_read_seq       bigint      NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT read_markers_order CHECK (last_read_seq >= 0 AND last_delivered_seq >= last_read_seq)
);

CREATE FUNCTION memberships_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  conv record;
BEGIN
  SELECT c.kind, c.last_seq INTO conv FROM public.conversations c WHERE c.id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF conv.kind = 'direct' AND NOT EXISTS (
       SELECT 1 FROM public.direct_conversations d
        WHERE d.conversation_id = NEW.conversation_id AND NEW.user_id IN (d.user_lo, d.user_hi)) THEN
    RAISE EXCEPTION 'only the two participants can be members of a direct conversation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_direct_participants';
  END IF;
  NEW.joined_seq := conv.last_seq + 1;
  NEW.joined_at := now();
  NEW.left_seq := NULL;
  NEW.left_at := NULL;
  NEW.left_reason := NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER memberships_before_insert BEFORE INSERT ON conversation_memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_before_insert();

-- A (re)joining member starts with everything before joined_seq marked read.
CREATE FUNCTION memberships_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.read_markers AS r (conversation_id, user_id, last_delivered_seq, last_read_seq)
  VALUES (NEW.conversation_id, NEW.user_id, NEW.joined_seq - 1, NEW.joined_seq - 1)
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET last_read_seq      = GREATEST(r.last_read_seq, EXCLUDED.last_read_seq),
        last_delivered_seq = GREATEST(r.last_delivered_seq, EXCLUDED.last_delivered_seq);
  RETURN NULL;
END
$$;
CREATE TRIGGER memberships_after_insert AFTER INSERT ON conversation_memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_after_insert();

CREATE FUNCTION memberships_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  conv record;
BEGIN
  IF NEW.id <> OLD.id OR NEW.conversation_id <> OLD.conversation_id OR NEW.user_id <> OLD.user_id
     OR NEW.joined_seq <> OLD.joined_seq OR NEW.joined_at <> OLD.joined_at THEN
    RAISE EXCEPTION 'immutable membership column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'a past membership cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.left_at IS NOT NULL THEN
    SELECT c.kind, c.last_seq INTO conv FROM public.conversations c WHERE c.id = NEW.conversation_id FOR UPDATE;
    IF conv.kind = 'direct' THEN
      RAISE EXCEPTION 'members cannot leave a direct conversation'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_direct_permanent';
    END IF;
    NEW.left_seq := conv.last_seq;
    NEW.left_at := now();
  ELSE
    NEW.left_seq := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER memberships_before_update BEFORE UPDATE ON conversation_memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_before_update();

CREATE FUNCTION memberships_forbid_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'memberships are never deleted; set left_at' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER memberships_forbid_delete BEFORE DELETE ON conversation_memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_forbid_delete();

CREATE FUNCTION read_markers_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cap bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.conversation_id <> OLD.conversation_id OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'immutable read marker column changed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.last_read_seq < OLD.last_read_seq OR NEW.last_delivered_seq < OLD.last_delivered_seq THEN
      RAISE EXCEPTION 'read markers only move forward'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'read_markers_forward_only';
    END IF;
  END IF;
  -- The highest seq this user can ever see here: last_seq while active, else the latest left_seq.
  SELECT max(COALESCE(p.left_seq, c.last_seq)) INTO cap
    FROM public.conversation_memberships p JOIN public.conversations c ON c.id = p.conversation_id
   WHERE p.conversation_id = NEW.conversation_id AND p.user_id = NEW.user_id;
  IF cap IS NULL OR NEW.last_delivered_seq > cap THEN
    RAISE EXCEPTION 'read marker beyond the visible range'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'read_markers_within_visible';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER read_markers_guard BEFORE INSERT OR UPDATE ON read_markers
  FOR EACH ROW EXECUTE FUNCTION read_markers_guard();

-- ──────────────────────────────────────────────────────────── messages
CREATE TABLE messages (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  conversation_id     uuid        NOT NULL REFERENCES conversations (id),
  -- Both assigned by messages_before_insert(); caller-supplied values are overwritten.
  seq                 bigint      NOT NULL DEFAULT 0,
  updated_change_seq  bigint      NOT NULL DEFAULT 0,
  sender_id           uuid        REFERENCES users (id),
  -- Client-generated id for idempotent sends; NULL for system messages.
  client_msg_id       uuid,
  -- SHA-256 of the body as first sent: lets a retry prove it is the same send. Erased on delete.
  send_body_sha256    bytea,
  kind                text        NOT NULL,
  body                text,
  -- System messages only, e.g. {"event": "member_added", "actor": "<uuid>", "target": "<uuid>"}.
  meta                jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  edited_at           timestamptz,
  deleted_at          timestamptz,
  CONSTRAINT messages_kind_check        CHECK (kind IN ('text', 'system')),
  CONSTRAINT messages_conv_seq_key      UNIQUE (conversation_id, seq),
  CONSTRAINT messages_conv_change_key   UNIQUE (conversation_id, updated_change_seq),
  CONSTRAINT messages_sender_client_key UNIQUE (sender_id, client_msg_id),
  CONSTRAINT messages_counters CHECK (seq >= 1 AND updated_change_seq >= seq),
  CONSTRAINT messages_text_shape CHECK (
    kind <> 'text' OR (sender_id IS NOT NULL AND client_msg_id IS NOT NULL AND meta IS NULL)),
  CONSTRAINT messages_system_shape CHECK (
    kind <> 'system' OR (sender_id IS NULL AND client_msg_id IS NULL AND send_body_sha256 IS NULL
                         AND body IS NULL AND meta IS NOT NULL AND edited_at IS NULL AND deleted_at IS NULL)),
  CONSTRAINT messages_live_text CHECK (
    kind <> 'text' OR deleted_at IS NOT NULL OR
    (char_length(body) BETWEEN 1 AND 4000 AND btrim(body) <> '' AND octet_length(send_body_sha256) = 32)),
  -- Delete-for-everyone erases content: a tombstone keeps only its identity and seq.
  CONSTRAINT messages_tombstone CHECK (deleted_at IS NULL OR (body IS NULL AND send_body_sha256 IS NULL))
);
-- messages_conv_seq_key serves history pages and seq catch-up; messages_conv_change_key serves
-- change-cursor catch-up; messages_sender_client_key serves idempotent retries.

-- Gap-free seq and change cursor, assigned in the inserting transaction under the conversation
-- row lock; a rolled-back insert rolls the increments back with it. The sender's membership is
-- checked after the lock is held, so a concurrent removal can't let a message slip in after
-- left_seq.
CREATE FUNCTION messages_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c record;
BEGIN
  UPDATE public.conversations
     SET last_seq = last_seq + 1, change_seq = change_seq + 1, last_message_at = now()
   WHERE id = NEW.conversation_id
  RETURNING last_seq, change_seq INTO c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.sender_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.conversation_memberships p
        WHERE p.conversation_id = NEW.conversation_id AND p.user_id = NEW.sender_id AND p.left_at IS NULL) THEN
    RAISE EXCEPTION 'sender is not an active member'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'messages_sender_active_member';
  END IF;
  NEW.seq := c.last_seq;
  NEW.updated_change_seq := c.change_seq;
  NEW.created_at := now();
  NEW.edited_at := NULL;
  NEW.deleted_at := NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_before_insert BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_before_insert();

-- Edits and delete-for-everyone: identity never changes, a tombstone never changes, deleting
-- erases body and hash, and every real change takes the next change cursor value.
CREATE FUNCTION messages_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.conversation_id <> OLD.conversation_id OR NEW.seq <> OLD.seq
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.client_msg_id IS DISTINCT FROM OLD.client_msg_id
     OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at OR NEW.meta IS DISTINCT FROM OLD.meta THEN
    RAISE EXCEPTION 'immutable message column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted message cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.kind <> 'text' THEN
    RAISE EXCEPTION 'only text messages can change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := now();
    NEW.body := NULL;
    NEW.send_body_sha256 := NULL;
    NEW.edited_at := OLD.edited_at;
  ELSIF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := now();
    NEW.send_body_sha256 := OLD.send_body_sha256;
  ELSE
    -- Nothing user-visible changed: keep everything, take no cursor value.
    NEW.edited_at := OLD.edited_at;
    NEW.send_body_sha256 := OLD.send_body_sha256;
    NEW.updated_change_seq := OLD.updated_change_seq;
    RETURN NEW;
  END IF;
  UPDATE public.conversations SET change_seq = change_seq + 1
   WHERE id = NEW.conversation_id
  RETURNING change_seq INTO NEW.updated_change_seq;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_before_update BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_before_update();

-- A hard delete would open a gap in seq. (chitthi_app has no DELETE grant either.)
CREATE FUNCTION messages_forbid_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'messages are never hard-deleted; use delete-for-everyone' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER messages_forbid_delete BEFORE DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_forbid_delete();

-- ──────────────────────────────────────────────────────── rate limits
-- Store for rate-limiter-flexible's RateLimiterPostgres (column order matters: it inserts
-- positionally as key, points, expire).
CREATE TABLE rate_limits (
  key     varchar(255) PRIMARY KEY,
  points  integer      NOT NULL DEFAULT 0,
  expire  bigint
);

-- ───────────────────────────────────────────── privileges for the API
GRANT SELECT ON reserved_handles TO chitthi_app;
GRANT SELECT, INSERT (handle, display_name), UPDATE (handle, display_name, disabled_at) ON users TO chitthi_app;
GRANT SELECT, INSERT (user_id, provider, subject, email, email_verified),
      UPDATE (email, email_verified, last_used_at) ON identities TO chitthi_app;
GRANT SELECT, INSERT (user_id, token_hash, expires_at, user_agent),
      UPDATE (last_seen_at, revoked_at), DELETE ON sessions TO chitthi_app;
GRANT SELECT, INSERT (kind, title, created_by), UPDATE (title) ON conversations TO chitthi_app;
GRANT SELECT, INSERT ON direct_conversations TO chitthi_app;
GRANT SELECT, INSERT (conversation_id, user_id, role), UPDATE (role, left_at, left_reason)
      ON conversation_memberships TO chitthi_app;
GRANT SELECT, UPDATE (last_delivered_seq, last_read_seq) ON read_markers TO chitthi_app;
GRANT SELECT, INSERT (conversation_id, sender_id, client_msg_id, send_body_sha256, kind, body, meta),
      UPDATE (body, deleted_at) ON messages TO chitthi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO chitthi_app;

-- migrate:down
DROP TABLE rate_limits;
DROP TABLE messages;
DROP FUNCTION messages_forbid_delete();
DROP FUNCTION messages_before_update();
DROP FUNCTION messages_before_insert();
DROP TABLE read_markers;
DROP FUNCTION read_markers_guard();
DROP TABLE conversation_memberships;
DROP FUNCTION memberships_forbid_delete();
DROP FUNCTION memberships_before_update();
DROP FUNCTION memberships_after_insert();
DROP FUNCTION memberships_before_insert();
DROP TABLE direct_conversations;
DROP FUNCTION direct_conversations_check_kind();
DROP TABLE conversations;
DROP FUNCTION conversations_guard();
DROP TABLE sessions;
DROP TABLE identities;
DROP TABLE users;
DROP FUNCTION users_reject_reserved_handle();
DROP TABLE reserved_handles;
