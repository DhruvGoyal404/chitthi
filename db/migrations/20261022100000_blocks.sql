-- migrate:up
-- Blocking (docs/AUTH.md, "Blocking"). A block is one person's decision about another:
-- (blocker, blocked). Its effects are enforced on the server in every path; the one the
-- database can enforce by itself, no new messages in a direct conversation between the two,
-- lives here.
CREATE TABLE user_blocks (
  blocker_id  uuid        NOT NULL REFERENCES users (id),
  blocked_id  uuid        NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);
-- "Has anyone blocked me?" (search, DM creation, group adds) reads by blocked_id.
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id, blocker_id);

-- With a block in either direction, neither participant of a direct conversation can send or
-- edit there (deleting your own message for everyone stays allowed). Named to fire after
-- messages_before_insert, so a send has already taken the conversation lock: a block that
-- commits first is always seen, and the rolled-back insert takes its seq with it (no gap).
CREATE FUNCTION messages_reject_blocked_direct() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind <> 'text' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.deleted_at IS NOT NULL OR NEW.body IS NOT DISTINCT FROM OLD.body) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.direct_conversations d
         JOIN public.user_blocks b
           ON (b.blocker_id = d.user_lo AND b.blocked_id = d.user_hi)
           OR (b.blocker_id = d.user_hi AND b.blocked_id = d.user_lo)
        WHERE d.conversation_id = NEW.conversation_id) THEN
    RAISE EXCEPTION 'a block is in place between the participants'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'messages_direct_blocked';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_reject_blocked_direct BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_reject_blocked_direct();

-- The realtime server hides (or restores) presence between the two at once.
CREATE FUNCTION user_blocks_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM pg_notify('chitthi_conv', json_build_object(
    'kind', 'block_changed', 'blocker_id', r.blocker_id, 'blocked_id', r.blocked_id, 'blocked', TG_OP = 'INSERT')::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER user_blocks_notify AFTER INSERT OR DELETE ON user_blocks
  FOR EACH ROW EXECUTE FUNCTION user_blocks_notify();

GRANT SELECT, INSERT, DELETE ON user_blocks TO chitthi_app;

-- migrate:down
REVOKE SELECT, INSERT, DELETE ON user_blocks FROM chitthi_app;
DROP TRIGGER user_blocks_notify ON user_blocks;
DROP FUNCTION user_blocks_notify();
DROP TRIGGER messages_reject_blocked_direct ON messages;
DROP FUNCTION messages_reject_blocked_direct();
DROP TABLE user_blocks;
