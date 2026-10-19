-- migrate:up
-- Receipt signals: whenever a member's read or delivered marker moves forward (it can only move
-- forward), notify ids and the new values. The API pushes read:updated / delivered:updated to
-- the reader's own tabs and to the other active members.
CREATE FUNCTION read_markers_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.last_read_seq = OLD.last_read_seq AND NEW.last_delivered_seq = OLD.last_delivered_seq THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('chitthi_conv', json_build_object(
    'kind', 'markers',
    'conversation_id', NEW.conversation_id,
    'user_id', NEW.user_id,
    'read_seq', NEW.last_read_seq,
    'delivered_seq', NEW.last_delivered_seq,
    'read_moved', NEW.last_read_seq > OLD.last_read_seq,
    'delivered_moved', NEW.last_delivered_seq > OLD.last_delivered_seq)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER read_markers_notify AFTER UPDATE ON read_markers
  FOR EACH ROW EXECUTE FUNCTION read_markers_notify();

-- migrate:down
DROP TRIGGER read_markers_notify ON read_markers;
DROP FUNCTION read_markers_notify();
