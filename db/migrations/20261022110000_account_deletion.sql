-- migrate:up
-- Account deletion (docs/AUTH.md, "Deleting an account"). The user row stays, because messages,
-- memberships and read markers point at it, but it is emptied: handle renamed, name "Deleted
-- user", no avatar, no identities, sessions or blocks. Group memberships close with reason
-- 'deleted'; direct conversations keep both members, and new messages to a deleted account
-- are refused.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_deleted_is_disabled CHECK (deleted_at IS NULL OR disabled_at IS NOT NULL);

-- A deleted account's handle stays unavailable for a while, so nobody can take it over and
-- pass as the person who just left.
CREATE TABLE handle_holds (
  handle      text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id),
  held_until  timestamptz NOT NULL,
  CONSTRAINT handle_holds_lowercase CHECK (handle = lower(handle))
);

CREATE OR REPLACE FUNCTION users_reject_reserved_handle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reserved_handles r WHERE r.handle = lower(NEW.handle)) THEN
    RAISE EXCEPTION 'handle is reserved'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_handle_reserved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.handle_holds h
              WHERE h.handle = lower(NEW.handle) AND h.held_until > now() AND h.user_id <> NEW.id) THEN
    RAISE EXCEPTION 'handle is held after an account deletion'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_handle_held';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE conversation_memberships DROP CONSTRAINT memberships_left_shape;
ALTER TABLE conversation_memberships ADD CONSTRAINT memberships_left_shape CHECK (
  (left_at IS NULL AND left_seq IS NULL AND left_reason IS NULL) OR
  (left_at IS NOT NULL AND left_seq IS NOT NULL AND left_reason IN ('left', 'removed', 'deleted')));

-- No new messages to a deleted account in a direct conversation (its history stays). Fires
-- after messages_before_insert, under the conversation lock, so a refusal leaves no seq gap.
CREATE FUNCTION messages_reject_deleted_direct() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'text' AND EXISTS (
       SELECT 1 FROM public.direct_conversations d
         JOIN public.users u ON u.id IN (d.user_lo, d.user_hi)
        WHERE d.conversation_id = NEW.conversation_id AND u.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the other participant deleted their account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'messages_direct_deleted';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_reject_deleted_direct BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_reject_deleted_direct();

GRANT SELECT, INSERT, UPDATE (user_id, held_until) ON handle_holds TO chitthi_app;
GRANT UPDATE (deleted_at) ON users TO chitthi_app;
GRANT DELETE ON identities TO chitthi_app;

-- migrate:down
REVOKE DELETE ON identities FROM chitthi_app;
REVOKE UPDATE (deleted_at) ON users FROM chitthi_app;
REVOKE SELECT, INSERT, UPDATE ON handle_holds FROM chitthi_app;
DROP TRIGGER messages_reject_deleted_direct ON messages;
DROP FUNCTION messages_reject_deleted_direct();
ALTER TABLE conversation_memberships DROP CONSTRAINT memberships_left_shape;
ALTER TABLE conversation_memberships ADD CONSTRAINT memberships_left_shape CHECK (
  (left_at IS NULL AND left_seq IS NULL AND left_reason IS NULL) OR
  (left_at IS NOT NULL AND left_seq IS NOT NULL AND left_reason IN ('left', 'removed')));
CREATE OR REPLACE FUNCTION users_reject_reserved_handle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reserved_handles r WHERE r.handle = lower(NEW.handle)) THEN
    RAISE EXCEPTION 'handle is reserved'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_handle_reserved';
  END IF;
  RETURN NEW;
END
$$;
DROP TABLE handle_holds;
ALTER TABLE users DROP CONSTRAINT users_deleted_is_disabled;
ALTER TABLE users DROP COLUMN deleted_at;
