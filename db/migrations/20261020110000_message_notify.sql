-- migrate:up
-- Fan-out signal for committed messages. NOTIFY is transactional (delivered on commit, in commit
-- order) and its payload is limited to 8000 bytes, while a body can be ~16 KB of UTF-8, so the
-- payload carries ids and counters only. The API's LISTEN connection reads the row once and
-- pushes it to every member whose window contains the seq (api/src/realtime/fanout.ts).
CREATE FUNCTION messages_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.updated_change_seq = OLD.updated_change_seq THEN
    RETURN NULL; -- a no-op update took no change value: nothing to tell anyone
  END IF;
  PERFORM pg_notify('chitthi_conv', json_build_object(
    'kind', CASE TG_OP WHEN 'INSERT' THEN 'message_new' ELSE 'message_updated' END,
    'conversation_id', NEW.conversation_id,
    'message_id', NEW.id,
    'seq', NEW.seq,
    'change_seq', NEW.updated_change_seq)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER messages_notify AFTER INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_notify();

-- migrate:down
DROP TRIGGER messages_notify ON messages;
DROP FUNCTION messages_notify();
