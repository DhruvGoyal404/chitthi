-- migrate:up
-- Session kill switch for open sockets: revoking a session, or disabling a user, notifies the
-- API's LISTEN connection, which disconnects the affected sockets at once. Payloads carry ids
-- only (NOTIFY payloads are limited to 8000 bytes, and there is nothing secret in an id).
CREATE FUNCTION sessions_notify_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('chitthi_session', json_build_object('session_id', NEW.id)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER sessions_notify_revoked AFTER UPDATE OF revoked_at ON sessions
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION sessions_notify_revoked();

CREATE FUNCTION users_notify_disabled() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('chitthi_session', json_build_object('user_id', NEW.id)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER users_notify_disabled AFTER UPDATE OF disabled_at ON users
  FOR EACH ROW WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
  EXECUTE FUNCTION users_notify_disabled();

-- migrate:down
DROP TRIGGER users_notify_disabled ON users;
DROP FUNCTION users_notify_disabled();
DROP TRIGGER sessions_notify_revoked ON sessions;
DROP FUNCTION sessions_notify_revoked();
