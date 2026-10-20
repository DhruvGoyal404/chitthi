-- migrate:up
-- A new membership period (DM creation, group creation, member added or re-added) notifies ids
-- only, so the API can exchange presence between the new member and the conversation's other
-- active members: two online users who start a DM see each other's status without reconnecting.
CREATE FUNCTION memberships_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('chitthi_conv', json_build_object(
    'kind', 'member_joined', 'conversation_id', NEW.conversation_id, 'user_id', NEW.user_id)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER memberships_notify AFTER INSERT ON conversation_memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_notify();

-- migrate:down
DROP TRIGGER memberships_notify ON conversation_memberships;
DROP FUNCTION memberships_notify();
